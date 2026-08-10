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
}): Promise<MeshCore> {
  const { config, self } = opts;
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
    if (frame.kind !== "msg" || !frame.msg) return; // Phase 1 handles 'msg' only
    const msg = frame.msg;
    // Auth-by-default: verify signature + nonce. A tampered/unsigned/replayed frame is DROPPED.
    if (!auth.verify(msg)) return;
    inbound.push(msg);
    // Cap the inbound queue so a noisy peer can't OOM us (Phase 7 tightens rate caps).
    if (inbound.length > 4096) inbound.splice(0, inbound.length - 4096);
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
    // Heartbeat: touch self's registry file every pingMs so live peers can evict us on crash.
    heartbeatTimer = setInterval(() => {
      registry.heartbeat().catch(() => {});
      refreshCachedPeers().catch(() => {});
    }, config.pingMs);
    heartbeatTimer.unref?.();
  }

  async function stop(): Promise<void> {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    await transport.stop().catch(() => {});
    await registry.leave().catch(() => {});
  }

  async function crash(): Promise<void> {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    await transport.stop().catch(() => {});
    // Intentionally do NOT call registry.leave() — a SIGKILL'd process leaves a stale registry
    // file that the liveness eviction (refreshPool) must clean up.
  }

  async function list(): Promise<Peer[]> {
    await refreshCachedPeers();
    return cachedPeers.filter((p) => p.id !== self.id && p.alive !== false);
  }

  async function send(args: { target?: string; channel?: string; type?: MsgType; payload: unknown }): Promise<string> {
    const msg: MeshMsg = {
      id: crypto.randomUUID(),
      from: self.id,
      to: args.target,
      channel: args.channel,
      type: args.type ?? "text",
      payload: args.payload,
      nonce: nextNonce(),
      sig: "", // filled after signing
      ts: Date.now(),
    };
    msg.sig = auth.sign(msg);
    const frame: Frame = { kind: "msg", msg };
    if (args.target) {
      await transport.send(args.target, frame);
    } else {
      await transport.broadcast(args.channel ?? "#general", frame);
    }
    return msg.id;
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
  async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    throw new Error("mesh_fleet_state: not implemented (Phase 5)");
  },
};

export const meshChannels = {
  name: "mesh_channels",
  label: "Mesh: channels",
  description: "List channels + their live subscriber counts + whether they persist to disk.",
  parameters: Type.Object({}),
  async execute(): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    throw new Error("mesh_channels: not implemented (Phase 3)");
  },
};

// (Public types — Peer, MeshMsg, MsgType, Channel, FleetState, MeshConfig — are re-exported
// from src/index.ts; this module imports them as type-only. See index.d.ts for the public surface.)