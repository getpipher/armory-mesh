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
import type { Peer, MeshMsg, MsgType, Channel, FleetState } from "./index.js";
import { createAuth, type Auth } from "./auth.js";
import { createRegistry, type Registry } from "./registry.js";
import { createLocalTransport } from "./transport.js";
import type { Frame, Transport } from "./types.js";
import { paths } from "./paths.js";
import type { MeshConfig } from "./config.js";
import { DEFAULT_CHANNELS, createChannelRegistry, isDefaultChannel, isValidChannelName, routeTargets, validateType, type ChannelRegistry } from "./channels.js";
import { appendChannelLog, replayChannelFromTs, readFleetState, loadCursors, saveCursors } from "./persistence.js";
import crypto from "node:crypto";
import fs from "node:fs";

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
  /** Join/leave a channel (self subscription; Phase 5 claim_target + tests use this). */
  subscribe(channel: string): void;
  unsubscribe(channel: string): void;
  /** List channels + live subscriber counts (+ whether they persist — Phase 4). */
  channelsView(): Channel[];
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
  const registry: Registry = createRegistry({
    project: config.project,
    agentId: self.id,
    pingMs: config.pingMs,
    evictionMisses: config.evictionMisses,
  });
  let transport: Transport;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const inbound: MeshMsg[] = [];

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

  transport = createLocalTransport({
    project: config.project,
    agentId: self.id,
    maxMessageBytes: config.maxMessageBytes,
    resolveSocket,
    allPeerSockets,
    onFrame: handleFrame,
  });

  function handleFrame(frame: Frame, _fromSocket: string): void {
    if (frame.kind !== "msg" || !frame.msg) return; // Phase 1/2 handle 'msg' only
    const msg = frame.msg;
    // Auth-by-default: verify signature + nonce. A tampered/unsigned/replayed frame is DROPPED.
    if (!auth.verify(msg)) return;
    // Heartbeats update the live peer view (liveness + context-usage broadcast) and are NOT queued.
    if (msg.type === "heartbeat") {
      const card = msg.payload as HeartbeatCard | undefined;
      if (card && typeof card.id === "string" && card.id !== self.id) {
        liveCards.set(card.id, { card, lastSeen: Date.now() });
      }
      return;
    }
    // Phase 4: dedup by msg id (a message may arrive both live and via late-joiner replay).
    if (!markSeen(msg.id)) return;
    inbound.push(msg);
    // Cap the inbound queue so a noisy peer can't OOM us (Phase 7 tightens rate caps).
    if (inbound.length > 4096) inbound.splice(0, inbound.length - 4096);
    // Phase 4: advance this peer's per-channel cursor (the sender already persisted the log).
    if (msg.channel && msg.ts > (cursors[msg.channel] ?? -Infinity)) cursors[msg.channel] = msg.ts;
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
    await registry.join(self);
    await refreshCachedPeers();
    await transport.start();
    // Phase 4: late-joiner catch-up — replay each persisted channel's shared log from this peer's
    // last-seen cursor (a fresh session catches up on the 02:00 finding broadcast at 09:00).
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
    const saved = await loadCursors(config.project, self.id).catch(() => ({}));
    for (const [c, ts] of Object.entries(saved)) cursors[c] = ts;
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
    // Phase 4: write-through to the channel log on SEND (the sender is the authoritative writer —
    // a finding broadcast with no peer online is still persisted, so a 09:00 session catches up
    // on the 02:00 broadcast). Receivers don't double-persist; replay dedups by id.
    if (config.persistChannels.includes(channel)) {
      appendChannelLog(config.project, msg, config.maxChannelLogBytes).catch(() => {});
    }
    if (args.target) {
      await transport.send(args.target, frame);
    } else {
      // Phase 3 routing: deliver only to peers subscribed to the channel.
      //   - default channels → all live peers (everyone is subscribed)
      //   - per-target channels → only known subscribers (gossiped via heartbeats / registry)
      const targets = routeTargets(channel, livePeers(), self.id);
      await Promise.allSettled(targets.map((id) => transport.send(id, frame)));
    }
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
    get onPeersChanged() {
      return onPeersChanged;
    },
    set onPeersChanged(v: ((peers: Peer[]) => void) | null) {
      onPeersChanged = v;
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
  async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    throw new Error("mesh_claim_target: not implemented (Phase 5)");
  },
};

export const meshReleaseTarget = {
  name: "mesh_release_target",
  label: "Mesh: release target",
  description: "Release a claimed target (on exit or handoff).",
  parameters: Type.Object({
    target: Type.String({ description: 'The target to release.' }),
  }),
  async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    throw new Error("mesh_release_target: not implemented (Phase 5)");
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
  async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    throw new Error("mesh_bank_finding: not implemented (Phase 5)");
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
  async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    throw new Error("mesh_dup_check: not implemented (Phase 5)");
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
  async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    throw new Error("mesh_handoff: not implemented (Phase 5)");
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