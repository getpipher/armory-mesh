// armory-mesh — the core. Wires transport + registry + auth + channels + persistence into the tool API.
// SCAFFOLD (Phase 0). Phase 1: the 4 core tools (coms parity). Phases 3/5: channels + fleet-state.
// See DESIGN.md §4 (the tool API) + ROADMAP.md.
//
// Each tool here is a pi tool descriptor (signature + handler). The extension entry
// (extensions/mesh.ts) registers them with ctx.tools.register.

import type { Peer, MeshMsg, MsgType, Channel, FleetState } from "./index.js";

// ─── Phase 1: the 4 core tools (coms parity) ──────────────────────────────

/** List live peers: name, model, host, context-window usage, claimed-target, last-seen. */
export const meshList = {
  name: "mesh_list",
  description: "List live peers in this project's mesh pool — name, model, host, live context-window usage, claimed-target, last-seen. The awareness primitive for a fleet of parallel pi sessions.",
  // TODO(Phase 1): params none; returns Peer[].
  async run(): Promise<Peer[]> {
    // TODO(Phase 1): registry.refreshPool() (evict stale) + return.
    throw new Error("mesh_list: not implemented (Phase 1)");
  },
};

/** Send a typed message to a peer or a channel. Returns a msg id once the receiver acks (or the broadcast is dispatched). */
export const meshSend = {
  name: "mesh_send",
  description: "Send a typed message to a peer (target set) or a channel (channel set). Types: finding / dup_check / scope / learning / handoff / claim / text. Signed + replay-protected on the wire.",
  // TODO(Phase 1/3): params { target?: id, channel?: string, type?: MsgType, payload: any } -> msgId: string
  async run(_args: { target?: string; channel?: string; type?: MsgType; payload: unknown }): Promise<string> {
    // TODO(Phase 1): auth.sign + transport.send/broadcast. Phase 3: channels.route + persistence.appendChannelLog.
    throw new Error("mesh_send: not implemented (Phase 1)");
  },
};

/** Pull messages (optionally filtered by channel + type), since a cursor. */
export const meshGet = {
  name: "mesh_get",
  description: "Pull incoming messages — optionally filtered by channel and/or type. For fire-and-forget consumption (vs mesh_await's blocking wait).",
  async run(_args: { channel?: string; type?: MsgType; since?: number }): Promise<MeshMsg[]> {
    throw new Error("mesh_get: not implemented (Phase 1)");
  },
};

/** Await a matching message (e.g., a dup_check_result). Blocks until a match arrives or the timeout hits. */
export const meshAwait = {
  name: "mesh_await",
  description: "Block until a matching message arrives (e.g., await a dup_check_result from a peer), or the timeout expires. The synchronous round-trip primitive.",
  async run(_args: { match: (m: MeshMsg) => boolean; timeoutMs?: number }): Promise<MeshMsg | undefined> {
    throw new Error("mesh_await: not implemented (Phase 1)");
  },
};

// ─── Phase 5: the fleet-state primitives (the "rich" layer) ────────────────

export const meshClaimTarget = {
  name: "mesh_claim_target",
  description: "Atomically claim a hunt target for this session. Other sessions see it via mesh_list + a 'claim' broadcast on #general. Prevents two sessions hunting the same target.",
  async run(_args: { target: string; scope?: string }): Promise<boolean> {
    throw new Error("mesh_claim_target: not implemented (Phase 5)");
  },
};

export const meshReleaseTarget = {
  name: "mesh_release_target",
  description: "Release a claimed target (on exit or handoff).",
  async run(_args: { target: string }): Promise<void> {
    throw new Error("mesh_release_target: not implemented (Phase 5)");
  },
};

export const meshBankFinding = {
  name: "mesh_bank_finding",
  description: "Announce + persist a banked finding on #dup-check. Persists to fleet-state.jsonl (never lost). Other sessions' mesh_dup_check queries match against these.",
  async run(_args: { target: string; severity: string; title: string; ref: string }): Promise<void> {
    throw new Error("mesh_bank_finding: not implemented (Phase 5)");
  },
};

export const meshDupCheck = {
  name: "mesh_dup_check",
  description: "Cross-hunt dup-check: broadcast a dup_check request on #dup-check + await the peers' dup_check_result responses. The killer feature for parallel bug-bounty (live cross-hunt dup-check before submitting).",
  async run(_args: { target: string; title: string; rootCause: string; timeoutMs?: number }): Promise<Array<{ from: string; overlap: boolean; note?: string }>> {
    throw new Error("mesh_dup_check: not implemented (Phase 5)");
  },
};

export const meshHandoff = {
  name: "mesh_handoff",
  description: "Announce a session-handoff pointer on #handoff (persists so the next session + the peers know where to resume).",
  async run(_args: { target: string; handoffPath: string }): Promise<void> {
    throw new Error("mesh_handoff: not implemented (Phase 5)");
  },
};

export const meshFleetState = {
  name: "mesh_fleet_state",
  description: "Read the durable fleet-state ledger — all claims, findings, handoffs, dup-checks. The persisted snapshot of the fleet (survives restarts; the durable HUNT-FLEET.md layer, structured + typed).",
  async run(): Promise<FleetState> {
    throw new Error("mesh_fleet_state: not implemented (Phase 5)");
  },
};

export const meshChannels = {
  name: "mesh_channels",
  description: "List channels + their live subscriber counts + whether they persist to disk.",
  async run(): Promise<Channel[]> {
    throw new Error("mesh_channels: not implemented (Phase 3)");
  },
};

// ─── The wiring (Phase 1+ — assembled by extensions/mesh.ts on load) ────────
// TODO(Phase 1): a Mesh class that holds { config, transport, registry, auth, channels?, persistence? }
//   + the heartbeat loop + the graceful-shutdown (release claims, close socket, deregister).
//   The tools above close over a module-level singleton Mesh instance set by extensions/mesh.ts.
export interface Mesh {
  // TODO(Phase 1): the assembled core. The tools delegate to this.
  start(): Promise<void>;
  stop(): Promise<void>;
}