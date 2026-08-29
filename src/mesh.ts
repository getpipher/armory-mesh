// armory-mesh — the core. Wires transport + registry + auth into the 4 Phase-1 tool run handlers
// (mesh_list / mesh_send / mesh_get / mesh_await) and exposes the Phase 3/5 tool descriptors
// (still throwing "not implemented (Phase N)" until those phases land).
//
// See DESIGN.md §4 (the tool API) + ROADMAP.md.
//
// The pi tool-descriptor contract (ToolDefinition): { name, label, description, parameters: Type.Object,
//   execute: async (toolCallId, params, signal, onUpdate, ctx) => AgentToolResult }.
// AgentToolResult = { content: (TextContent | ImageContent)[] }. The run handlers close over a
// module-level MeshCore singleton set by extensions/mesh.ts on session_start.

import { Type } from "@sinclair/typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Peer, MeshMsg, MsgType, Channel, FleetState, DupCheckResult, ObsEvent } from "./index.js";
import { createAuth, type Auth } from "./auth.js";
import { createRegistry, type Registry } from "./registry.js";
import { createLocalTransport, createHubTransport } from "./transport.js";
import type { Frame, Transport } from "./types.js";
import { paths } from "./paths.js";
import fs from "node:fs";

/** Env-gated file tracing (debug only — zero cost when PI_MESH_DEBUG_TRACE is unset). */
const trace = (line: string): void => {
  if (process.env.PI_MESH_DEBUG_TRACE) fs.appendFileSync(process.env.PI_MESH_DEBUG_TRACE, `${Date.now()} MESH ${line}\n`);
};
import type { MeshConfig } from "./config.js";
import { DEFAULT_CHANNELS, createChannelRegistry, isDefaultChannel, isValidChannelName, routeTargets, validateType, type ChannelRegistry } from "./channels.js";
import { appendChannelLog, replayChannelFromTs, readFleetState, appendFleetState, loadCursors, saveCursors } from "./persistence.js";
import { createFleetStatePrimitives, materializeReceivedFinding, type FleetStateCtx, type FleetStatePrimitives } from "./fleet-state.js";
import crypto from "node:crypto";

// ─── MeshCore — the assembled core the tools delegate to ────────────────────

export interface MeshCore {
  readonly self: Peer;
  readonly config: MeshConfig;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Simulate a hard crash (SIGKILL): stop the heartbeat + transport but leave the registry file so
   *  the liveness/eviction guarantee is testable. Production shutdown is `stop()` (graceful leave). */
  crash(): Promise<void>;
  list(): Promise<Peer[]>;
  /** Synchronous snapshot of the live peer view (for the pool widget's render). */
  snapshotPeers(): Peer[];
  /** Set by the extension to re-render the pool widget when the live peer set changes. */
  onPeersChanged: ((peers: Peer[]) => void) | null;
  /** Phase 7 observability sink — set by the extension/dogfood to receive ObsEvents (see index.d.ts). */
  onObs: ((e: ObsEvent) => void) | null;
  /** Join/leave a channel (self subscription; Phase 5 claim_target + tests use this). */
  subscribe(channel: string): void;
  unsubscribe(channel: string): void;
  /** List channels + live subscriber counts (+ whether they persist — Phase 4). */
  channelsView(): Channel[];
  // ── Phase 5: the fleet-state primitives (the “rich” layer) ──────────────────
  claimTarget(target: string, scope?: string): Promise<boolean>;
  releaseTarget(target: string): Promise<void>;
  bankFinding(target: string, severity: string, title: string, ref: string): Promise<void>;
  dupCheck(target: string, title: string, rootCause: string, timeoutMs?: number): Promise<DupCheckResult[]>;
  handoff(target: string, handoffPath: string): Promise<void>;
  send(args: { target?: string; channel?: string; type?: MsgType; payload: unknown }): Promise<string>;
  get(args: { channel?: string; type?: MsgType; since?: number }): Promise<MeshMsg[]>;
  awaitMsg(args: { channel?: string; type?: MsgType; from?: string; timeoutMs?: number }): Promise<MeshMsg | undefined>;
}

let meshCore: MeshCore | null = null;

export function setMesh(core: MeshCore | null): void {
  meshCore = core;
}

export function getMesh(): MeshCore {
  if (!meshCore) throw new Error("armory-mesh: not started — the mesh core is initialized on session_start.");
  return meshCore;
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Build the MeshCore: create auth + registry + transport, join the pool, start the heartbeat. */
export async function createMeshCore(opts: {
  config: MeshConfig;
  self: Peer;
  /** Live context-window usage reader (the extension wires this to ctx.getContextUsage). */
  getCtxUsage?: () => number | undefined;
}): Promise<MeshCore> {
  const { config, self } = opts;
  const getCtxUsage = opts.getCtxUsage ?? (() => undefined);
  const auth: Auth = createAuth({ project: config.project, selfId: self.id });
  // Phase 6.5: resolve the hub failover chain. hubUrls (array) takes precedence; fall back to a
  // single hubUrl. Empty/absent => local Unix-socket mode.
  const hubUrls = config.hubUrls && config.hubUrls.length > 0 ? config.hubUrls : config.hubUrl ? [config.hubUrl] : undefined;
  const isHubMode = !!(hubUrls && hubUrls.length > 0 && config.authToken);
  // Phase 6.5: peers this session can't reach directly (cross-machine, git-synced local mode) —
  // `send({target})` relays via a live peer instead of attempting a doomed direct connection.
  const unreachablePeers = new Set(config.unreachablePeers ?? []);
  let registry: Registry;
  let transport: Transport;
  if (isHubMode) {
    // Phase 6/6.5: hub mode — one HubTransport object serves as BOTH transport + registry (the hub
    // holds the live registry; no local file registry). Same tool API as local mode.
    const hub = createHubTransport({
      hubUrls: hubUrls!,
      authToken: config.authToken!,
      agentId: self.id,
      self,
      maxMessageBytes: config.maxMessageBytes,
      failoverThreshold: config.hubFailoverThreshold ?? 3,
      getCursors: () => ({ ...cursors }), // live cursors for reconnect gap back-fill (Phase 7)
    });
    registry = hub as unknown as Registry;
    transport = hub as unknown as Transport;
  } else {
    registry = createRegistry({
      project: config.project,
      agentId: self.id,
      pingMs: config.pingMs,
      evictionMisses: config.evictionMisses,
    });
    transport = null as unknown as Transport; // assigned below via createLocalTransport
  }
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const inbound: MeshMsg[] = [];

  // ── Phase 7: observability + the per-channel send-rate limiter ──────────────
  let onObs: ((e: ObsEvent) => void) | null = null;
  /** Emit an ObsEvent to the sink (if wired). Observability must NEVER break the mesh. */
  function emitObs(event_type: ObsEvent["event_type"], fields: Record<string, unknown> = {}): void {
    if (!onObs) return;
    try {
      onObs({ source_app: "armory-mesh", session_id: self.id, event_type, timestamp: new Date().toISOString(), ...fields });
    } catch {
      // a throwing sink must not take the mesh down
    }
  }
  // Token bucket per channel: burst up to channelRatePerSec, refill at channelRatePerSec msg/s.
  const rateBuckets = new Map(); // channel -> { tokens: number; last: number }
  function allowChannelSend(channel: string): boolean {
    // Control-plane exemption: liveness heartbeats must never be throttled (a throttled heartbeat
    // silently evicts the peer from every pool). Inbound heartbeats are bounded anyway (they update
    // liveCards in place, they never queue). Data-plane channels are capped normally.
    if (channel === "#heartbeats") return true;
    const rate = config.channelRatePerSec;
    if (!rate || rate <= 0) return true; // disabled (0/negative = no cap)
    const now = Date.now();
    const b = (rateBuckets.get(channel) ?? { tokens: rate, last: now }) as { tokens: number; last: number };
    b.tokens = Math.min(rate, b.tokens + ((now - b.last) / 1000) * rate);
    b.last = now;
    if (b.tokens < 1) {
      rateBuckets.set(channel, b);
      return false;
    }
    b.tokens -= 1;
    rateBuckets.set(channel, b);
    return true;
  }

  /** Live peer cards from received heartbeats (the awareness/liveness view for the widget + mesh_list). */
  interface HeartbeatCard {
    id: string;
    name: string;
    model: string;
    host: string;
    contextUsage?: number;
    claimedTarget?: string;
    channels?: string[];
  }
  const liveCards = new Map<string, { card: HeartbeatCard; lastSeen: number }>();
  let onPeersChanged: ((peers: Peer[]) => void) | null = null;
  let lastNotifiedSig = "";
  const myChannels: ChannelRegistry = createChannelRegistry({ initial: [...DEFAULT_CHANNELS] });
  // Phase 4: persistence + late-joiner replay.
  const seen = new Set<string>(); // processed msg ids (dedup for live vs replay overlap); bounded
  const SEEN_CAP = 8192;
  const cursors: Record<string, number> = {}; // channel -> last-seen ts (epoch ms)
  let cursorTimer: NodeJS.Timeout | null = null;
  function markSeen(id: string): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > SEEN_CAP) {
      const it = seen.values();
      for (let i = 0; i < SEEN_CAP / 2; i++) seen.delete(it.next().value);
    }
    return true;
  }

  // resolveSocket / allPeerSockets feed the transport from the live registry.
  function resolveSocket(id: string): string | undefined {
    // Prefer the cached peer snapshot (refreshed on each heartbeat); fall back to a fresh
    // synchronous read of the peer's registry file so a just-joined peer is reachable.
    const cached = cachedPeers.find((p) => p.id === id);
    if (cached?.socketPath) return cached.socketPath;
    try {
      const raw = fs.readFileSync(paths.agentFile(config.project, id), "utf-8");
      const peer = JSON.parse(raw) as Peer;
      return peer.socketPath;
    } catch {
      return undefined;
    }
  }

  function allPeerSockets(): Array<{ id: string; socketPath: string }> {
    // Snapshot via a fresh refreshPool result (cached after each heartbeat; see below).
    return cachedPeers
      .filter((p) => p.id !== self.id && p.socketPath)
      .map((p) => ({ id: p.id, socketPath: p.socketPath as string }));
  }

  let cachedPeers: Peer[] = [];

  async function refreshCachedPeers(): Promise<void> {
    cachedPeers = await registry.refreshPool();
  }

  if (isHubMode) {
    // Hub mode: the HubTransport is already created above; wire its onFrame to our handler.
    transport.onFrame(handleFrame);
  } else {
    transport = createLocalTransport({
      project: config.project,
      agentId: self.id,
      maxMessageBytes: config.maxMessageBytes,
      resolveSocket,
      allPeerSockets,
      onFrame: handleFrame,
    });
  }

  function handleFrame(frame: Frame, _fromSocket: string): void {
    // Phase 6.5: cross-machine late-joiner replay — the hub streams persisted channel history.
    // Each replayed message is verified + deduped + queued exactly like a live message.
    if (frame.kind === "replay" && Array.isArray(frame.msgs)) {
      let replayed = 0;
      for (const m of frame.msgs) {
        if (!m || m.type === "heartbeat") continue;
        if (!auth.verify(m)) { trace(`replay DROP verify-failed id=${m.id.slice(0, 8)} nonce=${m.nonce}`); emitObs("mesh_drop", { reason: "bad-signature-or-replayed-nonce", msgId: m.id, from: m.from, via: "replay" }); continue; }
        if (!markSeen(m.id)) continue;
        inbound.push(m);
        replayed++;
        // Phase 7: materialize received findings into the local ledger — HUB MODE ONLY. In local
        // mode every peer shares one fleet-state.jsonl on this machine (the sender's own write is
        // already visible); materializing there would just double-write the shared file.
        if (isHubMode && m.type === "finding") void materializeReceivedFinding(config.project, m.from, m.payload as Record<string, unknown>).catch(() => {});
        if (inbound.length > 4096) inbound.splice(0, inbound.length - 4096);
        if (m.channel && m.ts > (cursors[m.channel] ?? -Infinity)) cursors[m.channel] = m.ts;
      }
      if (replayed > 0) emitObs("mesh_replay", { channel: frame.channel, count: replayed });
      return;
    }
    if (frame.kind !== "msg" || !frame.msg) return; // Phase 1/2 handle 'msg' only
    const msg = frame.msg;
    // Heartbeats are idempotent presence frames (Phase 2): signature-only, NO nonce window. A
    // replayed heartbeat is harmless (the next real one overwrites the card), but letting them
    // advance the receiver's nonce window permanently poisons replay of OLDER stored messages —
    // a reconnecting peer could never re-accept the disconnect gap (found by smoke-reconnect:
    // B's window hit nonce 22 while the stored gap messages carried 12/13 → structural reject).
    if (msg.type === "heartbeat") {
      if (!auth.verifySignature(msg)) {
        emitObs("mesh_drop", { reason: "bad-signature", msgId: msg.id, from: msg.from, channel: msg.channel });
        return;
      }
      const card = msg.payload as HeartbeatCard | undefined;
      if (card && typeof card.id === "string" && card.id !== self.id) {
        liveCards.set(card.id, { card, lastSeen: Date.now() });
      }
      return;
    }
    // Auth-by-default: verify signature + nonce. A tampered/unsigned/replayed frame is DROPPED.
    if (!auth.verify(msg)) {
      emitObs("mesh_drop", { reason: "bad-signature-or-replayed-nonce", msgId: msg.id, from: msg.from, channel: msg.channel });
      return;
    }
    // Phase 6.5: mesh relay — a frame in transit (destination is another peer). Deliver or re-relay;
    // never queue (it's not for us). The visited-set + hop-count prevent loops (DESIGN §5.5).
    if (frame.relay && frame.relay.to !== self.id) {
      void handleRelay(frame);
      return;
    }
    // (frame.relay.to === self.id => final delivery: fall through to normal processing; the relay
    // metadata is transport-level + discarded here.)
    // Phase 5: a dup_check request is auto-answered (overlap check) — NOT queued.
    if (msg.type === "dup_check") {
      void fleet.respondToDupCheck(msg);
      return;
    }
    // Phase 4: dedup by msg id (a message may arrive both live and via late-joiner replay).
    if (!markSeen(msg.id)) {
      emitObs("mesh_drop", { reason: "duplicate", msgId: msg.id, from: msg.from, channel: msg.channel });
      return;
    }
    inbound.push(msg);
    emitObs("mesh_receive", { msgId: msg.id, from: msg.from, channel: msg.channel, type: msg.type });
    // Phase 7: materialize received findings into the local ledger — HUB MODE ONLY (cross-machine
    // fleet-state: a finding banked on machine Y becomes visible to machine X's mesh_dup_check
    // overlap check). Local mode shares one ledger file; materializing there would double-write.
    if (isHubMode && msg.type === "finding") void materializeReceivedFinding(config.project, msg.from, msg.payload as Record<string, unknown>).catch(() => {});
    // Cap the inbound queue so a noisy peer can't OOM us (Phase 7 tightens rate caps).
    if (inbound.length > 4096) inbound.splice(0, inbound.length - 4096);
    // Phase 4: advance this peer's per-channel cursor (the sender already persisted the log).
    if (msg.channel && msg.ts > (cursors[msg.channel] ?? -Infinity)) cursors[msg.channel] = msg.ts;
  }

  // ── Phase 6.5: mesh relay (hub-less cross-machine, loop-prevention) ──────────────────────
  function isUnreachable(id: string): boolean { return unreachablePeers.has(id); }

  /** Pick a live peer to relay through (excludes self, the target, + already-visited peers). */
  function pickRelayVia(target: string, visited: Set<string>): string | undefined {
    for (const p of livePeers()) {
      if (p.id === self.id || p.id === target) continue;
      if (visited.has(p.id)) continue;
      if (p.alive === false) continue;
      return p.id;
    }
    return undefined;
  }

  /** Deliver a targeted frame, falling back to mesh relay if the direct path is unavailable. */
  async function deliverWithRelay(target: string, frame: Frame): Promise<void> {
    if (!isUnreachable(target)) {
      try { await transport.send(target, frame); return; }
      catch { /* direct failed — fall back to relay */ }
    }
    const via = pickRelayVia(target, new Set([self.id, target]));
    if (!via) {
      throw new Error(
        isUnreachable(target)
          ? `transport: no relay peer for unreachable target "${target}"`
          : `transport: direct send failed + no relay peer for "${target}"`,
      );
    }
    const relayFrame: Frame = { ...frame, relay: { hops: 1, visited: [self.id, target], to: target } };
    emitObs("mesh_relay", { msgId: (frame.msg as MeshMsg | undefined)?.id, via, to: target, hops: 1, by: "sender" });
    await transport.send(via, relayFrame);
  }

  /** Process a relay frame in transit: deliver directly, re-relay via another peer, or drop (loop-prevention). */
  async function handleRelay(frame: Frame): Promise<void> {
    const relay = frame.relay!;
    const to = relay.to;
    // Try direct delivery (unless we know it's unreachable from us).
    if (!isUnreachable(to)) {
      try { await transport.send(to, { ...frame, relay: undefined }); return; }
      catch { /* direct failed — re-relay */ }
    }
    // Can't deliver directly — re-relay via a live peer not already visited, unless the hop cap is hit.
    if (relay.hops >= config.maxHops) {
      emitObs("mesh_drop", { reason: "hop-limit", msgId: (frame.msg as MeshMsg | undefined)?.id, to, hops: relay.hops }); // hard drop — loop-prevention (DESIGN §5.5)
      return;
    }
    const visited = new Set(relay.visited);
    visited.add(self.id);
    const via = pickRelayVia(to, visited);
    if (!via) {
      emitObs("mesh_drop", { reason: "no-relay-peer", msgId: (frame.msg as MeshMsg | undefined)?.id, to, hops: relay.hops }); // no loop, just undeliverable
      return;
    }
    const relayFrame: Frame = { ...frame, relay: { hops: relay.hops + 1, visited: [...visited], to } };
    emitObs("mesh_relay", { msgId: (frame.msg as MeshMsg | undefined)?.id, via, to, hops: relay.hops + 1, by: "relay-peer" });
    try { await transport.send(via, relayFrame); } catch { /* best-effort */ }
  }

  let nonceCounter = 0;
  function nextNonce(): number {
    return ++nonceCounter;
  }

  async function start(): Promise<void> {
    await auth.ensureKey();
    if (!(await auth.ensureAllowlisted(self.id))) {
      throw new Error(`armory-mesh: agent "${self.id}" is not in the project allowlist for "${config.project}".`);
    }
    // Phase 6.5: load the saved per-channel cursors BEFORE join so the hub can replay cross-machine
    // history from them (the join request carries them; the hub streams `replay` frames over SSE).
    const savedCursors = await loadCursors(config.project, self.id).catch(() => ({}));
    for (const [c, ts] of Object.entries(savedCursors)) cursors[c] = ts;
    // Open the inbound transport BEFORE joining (hub mode: SSE must be open so the hub can stream
    // replay frames on /join; local mode: the socket server listens for inbound frames).
    await transport.start();
    await registry.join(self, savedCursors);
    await refreshCachedPeers();
    // Phase 4 (local mode): late-joiner catch-up — replay each persisted channel's SHARED log from
    // this peer's last-seen cursor (a fresh session catches up on the 02:00 finding at 09:00). In
    // hub mode the cross-machine replay already arrived via the SSE `replay` frames; this is a no-op
    // (no shared local log) + dedup (markSeen) guards against any overlap.
    await catchUpPersistedChannels();
    // Cursor persistence: save cursors periodically + on shutdown (so a restarted session resumes).
    cursorTimer = setInterval(() => { saveCursors(config.project, self.id, cursors).catch(() => {}); }, 2000);
    cursorTimer.unref?.();
    // Heartbeat loop (Phase 2): every pingMs —
    //   1. self-heal + write self's registry file with live lastSeen + contextUsage
    //   2. broadcast a SIGNED 'heartbeat' message on #heartbeats (the context-usage + liveness broadcast)
    //   3. evict live cards we haven't heard from in evictionMisses * pingMs (gossip liveness)
    //   4. notify the extension (→ pool widget re-render) when the live peer set changes
    heartbeatTimer = setInterval(async () => {
      try {
        // self-heal + write live lastSeen + contextUsage + channels (one write).
        await registry.updateSelf({ contextUsage: getCtxUsage() ?? undefined, channels: myChannels.list() });
      } catch {
        // best-effort
      }
      const card: HeartbeatCard = {
        id: self.id,
        name: self.name,
        model: self.model,
        host: self.host,
        contextUsage: getCtxUsage(),
        claimedTarget: self.claimedTarget,
        channels: myChannels.list(),
      };
      await send({ channel: "#heartbeats", type: "heartbeat", payload: card }).catch(() => {});
      // Gossip eviction: drop silent live cards.
      const now = Date.now();
      const staleAfterMs = config.pingMs * config.evictionMisses;
      let changed = false;
      for (const [id, live] of liveCards) {
        if (id === self.id) continue;
        if (now - live.lastSeen > staleAfterMs) {
          liveCards.delete(id);
          changed = true;
          emitObs("mesh_evict", { peer: id, name: live.card.name, reason: "heartbeat-timeout", lastSeenAgeMs: now - live.lastSeen });
        }
      }
      await refreshCachedPeers().catch(() => {});
      if (changed) {
        const peers = livePeers();
        const sig = peers.map((p) => `${p.id}:${p.lastSeen ?? 0}:${p.contextUsage ?? "-"}`).join("|");
        if (sig !== lastNotifiedSig && onPeersChanged) {
          lastNotifiedSig = sig;
          try { onPeersChanged(peers); } catch { /* best-effort */ }
        }
      }
    }, config.pingMs);
    heartbeatTimer.unref?.();
  }

  /** Phase 4: replay each persisted channel's shared log from this peer's saved cursor; merge new
   *  messages into the inbound queue (dedup by id). */
  async function catchUpPersistedChannels(): Promise<void> {
    // The cursors were already loaded in start() (so the hub join could carry them for cross-machine
    // replay). Here we only read the SHARED local log (local mode) from those cursors; in hub mode
    // there's no shared local log, so this is a no-op (the hub replay already handled catch-up).
    for (const channel of config.persistChannels) {
      const sinceTs = cursors[channel] ?? -Infinity;
      let msgs: MeshMsg[] = [];
      try { msgs = await replayChannelFromTs(config.project, channel, sinceTs); } catch { /* no log yet */ }
      for (const m of msgs) {
        if (m.type === "heartbeat") continue;
        if (!markSeen(m.id)) continue;
        inbound.push(m);
        if (m.ts > (cursors[channel] ?? -Infinity)) cursors[channel] = m.ts;
      }
    }
  }

  async function stop(): Promise<void> {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (cursorTimer) {
      clearInterval(cursorTimer);
      cursorTimer = null;
    }
    onPeersChanged = null;
    await saveCursors(config.project, self.id, cursors).catch(() => {}); // graceful: persist the resume cursor
    await transport.stop().catch(() => {});
    await registry.leave().catch(() => {});
  }

  async function crash(): Promise<void> {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (cursorTimer) {
      clearInterval(cursorTimer);
      cursorTimer = null;
    }
    await saveCursors(config.project, self.id, cursors).catch(() => {}); // best-effort: save progress
    await transport.stop().catch(() => {});
    // Intentionally do NOT call registry.leave() — a SIGKILL'd process leaves a stale registry
    // file that the liveness eviction (refreshPool) must clean up.
  }

  /** The live peer view: registry discovery (hard eviction by lastSeen) merged with live heartbeat
   *  cards (fresh context usage + name/model/claim). Excludes self. */
  function livePeers(): Peer[] {
    const merged = new Map<string, Peer>();
    for (const p of cachedPeers) {
      if (p.id === self.id || p.alive === false) continue;
      merged.set(p.id, { ...p });
    }
    for (const [id, live] of liveCards) {
      if (id === self.id) continue;
      const existing = merged.get(id);
      const card = live.card;
      const view: Peer = existing
        ? {
            ...existing,
            name: card.name ?? existing.name,
            model: card.model ?? existing.model,
            contextUsage: card.contextUsage ?? existing.contextUsage,
            claimedTarget: card.claimedTarget ?? existing.claimedTarget,
            channels: card.channels ?? existing.channels,
            lastSeen: live.lastSeen,
          }
        : {
            id,
            name: card.name ?? "unknown",
            model: card.model ?? "unknown",
            host: card.host ?? "",
            socketPath: undefined,
            contextUsage: card.contextUsage,
            claimedTarget: card.claimedTarget,
            channels: card.channels,
            lastSeen: live.lastSeen,
            alive: true,
          };
      merged.set(id, view);
    }
    return [...merged.values()];
  }

  function snapshotPeers(): Peer[] {
    return livePeers();
  }

  async function list(): Promise<Peer[]> {
    await refreshCachedPeers();
    return livePeers();
  }

  async function send(args: { target?: string; channel?: string; type?: MsgType; payload: unknown }): Promise<string> {
    const type = args.type ?? "text";
    // Phase 3: validate the payload against the message type (typed messages).
    const errors = validateType(type, args.payload);
    if (errors.length > 0) {
      throw new Error("mesh_send: invalid payload for type " + JSON.stringify(type) + ": " + errors.join("; "));
    }
    const channel = args.channel ?? "#general";
    if (!isValidChannelName(channel)) {
      throw new Error("mesh_send: invalid channel name " + JSON.stringify(channel) + " (must start with '#', no spaces)");
    }
    // Phase 7: per-channel send-rate cap (token bucket). A noisy peer can't drown the pool
    // (DESIGN §5.6). Rejected sends are NOT persisted (the durable ledger only holds real sends).
    if (!allowChannelSend(channel)) {
      emitObs("mesh_drop", { reason: "rate-limit", channel, type });
      throw new Error(`mesh_send: rate limit exceeded on ${channel} (max ${config.channelRatePerSec} msg/s) — retry shortly`);
    }
    // Auto-join the channel we send on (so future heartbeats advertise the subscription).
    myChannels.join(channel);
    const msg: MeshMsg = {
      id: crypto.randomUUID(),
      from: self.id,
      to: args.target,
      channel,
      type,
      payload: args.payload,
      nonce: nextNonce(),
      sig: "", // filled after signing
      ts: Date.now(),
    };
    msg.sig = auth.sign(msg);
    const frame: Frame = { kind: "msg", msg };
    // Phase 7: explicit size cap with a clear error (the transport also rejects oversized frames on
    // the wire — this fails fast + names the limit).
    const frameBytes = Buffer.byteLength(JSON.stringify(frame), "utf-8");
    if (frameBytes > config.maxMessageBytes) {
      emitObs("mesh_drop", { reason: "oversize", channel, type, bytes: frameBytes, cap: config.maxMessageBytes });
      throw new Error(`mesh_send: message exceeds cap (${frameBytes} > ${config.maxMessageBytes} bytes) — shrink the payload`);
    }
    // Phase 4: write-through to the channel log on SEND (the sender is the authoritative writer —
    // a finding broadcast with no peer online is still persisted, so a 09:00 session catches up
    // on the 02:00 broadcast). Receivers don't double-persist; replay dedups by id.
    if (config.persistChannels.includes(channel)) {
      appendChannelLog(config.project, msg, config.maxChannelLogBytes).catch(() => {});
    }
    if (args.target) {
      // Phase 6.5: try direct; on failure (or known-unreachable) fall back to mesh relay via a live peer.
      await deliverWithRelay(args.target, frame);
    } else if (isHubMode) {
      // Hub mode: ONE POST /send — the hub routes to subscribers AND stores persisted-channel
      // messages for cross-machine late-joiner replay. This matters when the sender is the only
      // peer online (a 02:00 finding broadcast with no subscribers must still reach the hub's
      // durable store so a 09:00 session catches up).
      await transport.broadcast(channel, frame);
    } else {
      // Local mode: route directly to known subscribers (the shared-filesystem pool).
      //   - default channels → all live peers (everyone is subscribed)
      //   - per-target channels → only known subscribers (gossiped via heartbeats / registry)
      const targets = routeTargets(channel, livePeers(), self.id);
      await Promise.allSettled(targets.map((id) => transport.send(id, frame)));
    }
    emitObs("mesh_send", { msgId: msg.id, channel, type, to: args.target, bytes: frameBytes });
    return msg.id;
  }

  function subscribe(channel: string): void {
    myChannels.join(channel);
    registry.updateSelf({ channels: myChannels.list() }).catch(() => {});
  }

  function unsubscribe(channel: string): void {
    if (isDefaultChannel(channel)) return; // defaults can't be left
    myChannels.leave(channel);
    registry.updateSelf({ channels: myChannels.list() }).catch(() => {});
  }

  function channelsView(): Channel[] {
    const counts = new Map<string, number>();
    for (const p of livePeers()) {
      for (const c of p.channels ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const selfChannels = myChannels.list();
    const seen = new Set<string>();
    const out: Channel[] = [];
    for (const c of selfChannels) {
      seen.add(c);
      out.push({ name: c, subscribers: 1 + (counts.get(c) ?? 0), persisted: config.persistChannels.includes(c) });
    }
    for (const [c, n] of counts) {
      if (seen.has(c)) continue;
      out.push({ name: c, subscribers: n, persisted: config.persistChannels.includes(c) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  function matches(msg: MeshMsg, f: { channel?: string; type?: MsgType; from?: string }): boolean {
    if (f.channel !== undefined && msg.channel !== f.channel) return false;
    if (f.type !== undefined && msg.type !== f.type) return false;
    if (f.from !== undefined && msg.from !== f.from) return false;
    return true;
  }

  async function get(args: { channel?: string; type?: MsgType; since?: number }): Promise<MeshMsg[]> {
    const picked: MeshMsg[] = [];
    for (let i = 0; i < inbound.length; ) {
      const m = inbound[i];
      const sinceOk = args.since === undefined || m.ts > args.since;
      if (matches(m, args) && sinceOk) {
        picked.push(m);
        inbound.splice(i, 1); // consume (fire-and-forget)
      } else {
        i++;
      }
    }
    return picked;
  }

  async function awaitMsg(args: { channel?: string; type?: MsgType; from?: string; timeoutMs?: number }): Promise<MeshMsg | undefined> {
    const deadline = Date.now() + (args.timeoutMs ?? 5000);
    const pollMs = 50;
    // First, consume any already-queued match.
    for (let i = 0; i < inbound.length; ) {
      const m = inbound[i];
      if (matches(m, args)) {
        inbound.splice(i, 1);
        return m;
      }
      i++;
    }
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      for (let i = 0; i < inbound.length; ) {
        const m = inbound[i];
        if (matches(m, args)) {
          inbound.splice(i, 1);
          return m;
        }
        i++;
      }
    }
    return undefined;
  }

  // Phase 5: wire the fleet-state primitives (claim/bank/dup-check/handoff).
  function setClaimedTarget(target: string | undefined): void {
    self.claimedTarget = target;
    registry.updateSelf({ claimedTarget: target }).catch(() => {});
  }
  function signBody(m: Omit<MeshMsg, "sig">): string { return auth.sign(m); }
  function transportSend(to: string, frame: { kind: "msg"; msg: MeshMsg }): Promise<void> { return transport.send(to, frame); }
  const fleetCtx: FleetStateCtx = {
    project: config.project,
    selfId: self.id,
    pingMs: config.pingMs,
    evictionMisses: config.evictionMisses,
    setClaimedTarget,
    sign: signBody,
    nextNonce,
    send,
    transportSend,
    inbound,
  };
  const fleet = createFleetStatePrimitives(fleetCtx);

  return {
    self,
    config,
    start,
    stop,
    crash,
    list,
    snapshotPeers,
    subscribe,
    unsubscribe,
    channelsView,
    claimTarget: fleet.claimTarget,
    releaseTarget: fleet.releaseTarget,
    bankFinding: fleet.bankFinding,
    dupCheck: fleet.dupCheck,
    handoff: fleet.handoff,
    get onPeersChanged() {
      return onPeersChanged;
    },
    set onPeersChanged(v: ((peers: Peer[]) => void) | null) {
      onPeersChanged = v;
    },
    get onObs() {
      return onObs;
    },
    set onObs(v: ((e: ObsEvent) => void) | null) {
      onObs = v;
    },
    send,
    get,
    awaitMsg,
  };
}

// ─── Phase 1: the 4 core tools (coms parity) ────────────────────────────────

export const meshList = {
  name: "mesh_list",
  label: "Mesh: list peers",
  description:
    "List live peers in this project's mesh pool — name, model, host, live context-window usage, claimed-target, last-seen. The awareness primitive for a fleet of parallel pi sessions.",
  parameters: Type.Object({
    project: Type.Optional(Type.String({ description: 'Project pool to list. Defaults to this session\'s project.' })),
  }),
  async execute(_toolCallId: string, args: { project?: string }, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    if (args.project && args.project !== core.config.project) {
      return textResult(`mesh_list: cross-project listing is not supported in Phase 1 (this session is in project "${core.config.project}").`);
    }
    const peers = await core.list();
    return textResult(JSON.stringify(peers, null, 2));
  },
};

export const meshSend = {
  name: "mesh_send",
  label: "Mesh: send message",
  description:
    "Send a typed message to a peer (target set) or a channel (channel set). Types: finding / dup_check / scope / learning / handoff / claim / text. Signed + replay-protected on the wire.",
  parameters: Type.Object({
    target: Type.Optional(Type.String({ description: 'Peer agent id (scoped to the project). Omit to broadcast to a channel.' })),
    channel: Type.Optional(Type.String({ description: 'Channel/topic (e.g. "#dup-check"). Used when target is omitted (broadcast).' })),
    type: Type.Optional(Type.String({ description: 'Message type (finding / dup_check / scope / learning / handoff / claim / text). Defaults to "text".' })),
    payload: Type.Any({ description: 'The message payload (type-specific shape; see DESIGN.md §3.4).' }),
  }),
  async execute(_toolCallId: string, args: { target?: string; channel?: string; type?: MsgType; payload: unknown }, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    try {
      const id = await core.send({ target: args.target, channel: args.channel, type: args.type, payload: args.payload });
      return textResult(JSON.stringify({ ok: true, id, to: args.target ?? `channel:${args.channel ?? "#general"}` }));
    } catch (err) {
      return textResult(`mesh_send failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const meshGet = {
  name: "mesh_get",
  label: "Mesh: get messages",
  description:
    "Pull incoming messages — optionally filtered by channel and/or type. For fire-and-forget consumption (vs mesh_await's blocking wait). Consumes matched messages from the inbound queue.",
  parameters: Type.Object({
    channel: Type.Optional(Type.String({ description: 'Filter to a channel.' })),
    type: Type.Optional(Type.String({ description: 'Filter to a message type.' })),
    since: Type.Optional(Type.Number({ description: 'Only messages with ts > since (epoch ms).' })),
  }),
  async execute(_toolCallId: string, args: { channel?: string; type?: MsgType; since?: number }, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    const msgs = await core.get({ channel: args.channel, type: args.type, since: args.since });
    return textResult(JSON.stringify(msgs, null, 2));
  },
};

export const meshAwait = {
  name: "mesh_await",
  label: "Mesh: await message",
  description:
    "Block until a matching message arrives (e.g., await a dup_check_result from a peer), or the timeout expires. The synchronous round-trip primitive. Consumes the matched message.",
  parameters: Type.Object({
    channel: Type.Optional(Type.String({ description: 'Await on this channel.' })),
    type: Type.Optional(Type.String({ description: 'Await a message of this type (e.g. "dup_check_result").' })),
    from: Type.Optional(Type.String({ description: 'Await a message from this specific peer.' })),
    timeoutMs: Type.Optional(Type.Number({ description: 'Timeout in ms (default 5000).' })),
  }),
  async execute(_toolCallId: string, args: { channel?: string; type?: MsgType; from?: string; timeoutMs?: number }, signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    // Honor an abort signal: if the agent cancels, resolve early.
    const onAbort = () => {};
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const msg = await core.awaitMsg({ channel: args.channel, type: args.type, from: args.from, timeoutMs: args.timeoutMs });
      return textResult(msg ? JSON.stringify(msg, null, 2) : "mesh_await: timed out (no matching message).");
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  },
};

// ─── Phase 5: the fleet-state primitives (the "rich" layer) ──────────────────

export const meshClaimTarget = {
  name: "mesh_claim_target",
  label: "Mesh: claim target",
  description:
    "Atomically claim a hunt target for this session. Other sessions see it via mesh_list + a 'claim' broadcast on #general. Prevents two sessions hunting the same target.",
  parameters: Type.Object({
    target: Type.String({ description: 'The hunt target to claim (e.g. "gmtrade").' }),
    scope: Type.Optional(Type.String({ description: 'Optional scope summary to share with the fleet.' })),
  }),
  async execute(_toolCallId: string, args: { target: string; scope?: string }, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    try {
      const won = await core.claimTarget(args.target, args.scope);
      return textResult(won ? `claimed "${args.target}"` : `claim LOST — another session holds "${args.target}" (see mesh_list)`);
    } catch (err) { return textResult(`mesh_claim_target failed: ${err instanceof Error ? err.message : String(err)}`); }
  },
};

export const meshReleaseTarget = {
  name: "mesh_release_target",
  label: "Mesh: release target",
  description: "Release a claimed target (on exit or handoff).",
  parameters: Type.Object({
    target: Type.String({ description: 'The target to release.' }),
  }),
  async execute(_toolCallId: string, args: { target: string }, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    try { await core.releaseTarget(args.target); return textResult(`released "${args.target}"`); }
    catch (err) { return textResult(`mesh_release_target failed: ${err instanceof Error ? err.message : String(err)}`); }
  },
};

export const meshBankFinding = {
  name: "mesh_bank_finding",
  label: "Mesh: bank finding",
  description:
    "Announce + persist a banked finding on #dup-check. Persists to fleet-state.jsonl (never lost). Other sessions' mesh_dup_check queries match against these.",
  parameters: Type.Object({
    target: Type.String({ description: 'The target the finding is on.' }),
    severity: Type.String({ description: 'Severity (e.g. "HIGH" / "Med").' }),
    title: Type.String({ description: 'Short finding title.' }),
    ref: Type.String({ description: 'Reference (file path / gist / report id).' }),
  }),
  async execute(_toolCallId: string, args: { target: string; severity: string; title: string; ref: string }, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    try { await core.bankFinding(args.target, args.severity, args.title, args.ref); return textResult(`banked finding: ${args.title} (${args.severity}) on ${args.target}`); }
    catch (err) { return textResult(`mesh_bank_finding failed: ${err instanceof Error ? err.message : String(err)}`); }
  },
};

export const meshDupCheck = {
  name: "mesh_dup_check",
  label: "Mesh: dup-check",
  description:
    "Cross-hunt dup-check: broadcast a dup_check request on #dup-check + await the peers' dup_check_result responses. The killer feature for parallel bug-bounty (live cross-hunt dup-check before submitting).",
  parameters: Type.Object({
    target: Type.String({ description: 'The target the candidate finding is on.' }),
    title: Type.String({ description: 'The candidate finding title.' }),
    rootCause: Type.String({ description: 'The root-cause summary (for overlap matching).' }),
    timeoutMs: Type.Optional(Type.Number({ description: 'Await timeout in ms (default 5000).' })),
  }),
  async execute(_toolCallId: string, args: { target: string; title: string; rootCause: string; timeoutMs?: number }, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    try {
      const results = await core.dupCheck(args.target, args.title, args.rootCause, args.timeoutMs);
      const overlap = results.filter((r) => r.overlap);
      const summary = overlap.length > 0
        ? `DUP-OVERLAP detected from ${overlap.map((r) => r.from.slice(0, 8)).join(",")}: ${overlap.map((r) => r.note).filter(Boolean).join("; ")}`
        : `no overlap (${results.length} response${results.length === 1 ? "" : "s"})`;
      return textResult(JSON.stringify({ results, summary }, null, 2));
    } catch (err) { return textResult(`mesh_dup_check failed: ${err instanceof Error ? err.message : String(err)}`); }
  },
};

export const meshHandoff = {
  name: "mesh_handoff",
  label: "Mesh: handoff",
  description:
    "Announce a session-handoff pointer on #handoff (persists so the next session + the peers know where to resume).",
  parameters: Type.Object({
    target: Type.String({ description: 'The target being handed off.' }),
    handoffPath: Type.String({ description: 'Path to the handoff file.' }),
  }),
  async execute(_toolCallId: string, args: { target: string; handoffPath: string }, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    try { await core.handoff(args.target, args.handoffPath); return textResult(`handoff announced: ${args.handoffPath} (target ${args.target})`); }
    catch (err) { return textResult(`mesh_handoff failed: ${err instanceof Error ? err.message : String(err)}`); }
  },
};

export const meshFleetState = {
  name: "mesh_fleet_state",
  label: "Mesh: fleet state",
  description:
    "Read the durable fleet-state ledger — all claims, findings, handoffs, dup-checks. The persisted snapshot of the fleet (survives restarts; the durable HUNT-FLEET.md layer, structured + typed).",
  parameters: Type.Object({}),
  async execute(_toolCallId: string, _args: Record<string, never>, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    const entries = await readFleetState(core.config.project);
    return textResult(JSON.stringify({ project: core.config.project, entries }, null, 2));
  },
};

export const meshChannels = {
  name: "mesh_channels",
  label: "Mesh: channels",
  description: "List channels + their live subscriber counts + whether they persist to disk.",
  parameters: Type.Object({}),
  async execute(_toolCallId: string, _args: Record<string, never>, _signal, _onUpdate, _ctx: ExtensionContext) {
    const core = getMesh();
    return textResult(JSON.stringify(core.channelsView(), null, 2));
  },
};

// (Public types — Peer, MeshMsg, MsgType, Channel, FleetState, MeshConfig — are re-exported
// from src/index.ts; this module imports them as type-only. See index.d.ts for the public surface.)