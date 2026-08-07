// armory-mesh — the core. The mesh tool descriptors (name + description + Type.Object parameters + run).
// SCAFFOLD (Phase 0). Phase 1: the 4 core tools (coms parity). Phases 3/5: channels + fleet-state.
// See DESIGN.md §4 (the tool API) + ROADMAP.md.
//
// The pi tool-descriptor contract: { name, description, parameters: Type.Object({...}), run: async (args, ctx) => result }.
// The run handlers below throw "not implemented (Phase N)" until the relevant phase lands.

import { Type } from "@sinclair/typebox";
import type { Peer, MeshMsg, MsgType, Channel, FleetState } from "./index.js";

// NOTE: the `ctx` arg of each `run` is the pi tool-call context (cwd, model, ui, … — see
// @earendil-works/pi-coding-agent's tool-call context). Typed loosely here; the build session tightens it.

// ─── Phase 1: the 4 core tools (coms parity) ──────────────────────────────

export const meshList = {
  name: "mesh_list",
  description:
    "List live peers in this project's mesh pool — name, model, host, live context-window usage, claimed-target, last-seen. The awareness primitive for a fleet of parallel pi sessions.",
  parameters: Type.Object({
    project: Type.Optional(Type.String({ description: 'Project pool to list. Defaults to this session\'s project.' })),
  }),
  async run(_args: { project?: string }, _ctx: unknown): Promise<Peer[]> {
    // TODO(Phase 1): registry.refreshPool() (evict stale) + return.
    throw new Error("mesh_list: not implemented (Phase 1)");
  },
};

export const meshSend = {
  name: "mesh_send",
  description:
    "Send a typed message to a peer (target set) or a channel (channel set). Types: finding / dup_check / scope / learning / handoff / claim / text. Signed + replay-protected on the wire.",
  parameters: Type.Object({
    target: Type.Optional(Type.String({ description: 'Peer agent id (scoped to the project). Omit to broadcast to a channel.' })),
    channel: Type.Optional(Type.String({ description: 'Channel/topic (e.g. "#dup-check"). Used when target is omitted (broadcast).' })),
    type: Type.Optional(Type.String({ description: 'Message type (finding / dup_check / scope / learning / handoff / claim / text). Defaults to "text".' })),
    payload: Type.Any({ description: 'The message payload (type-specific shape; see DESIGN.md §3.4).' }),
  }),
  async run(_args: { target?: string; channel?: string; type?: MsgType; payload: unknown }, _ctx: unknown): Promise<string> {
    // TODO(Phase 1): auth.sign + transport.send/broadcast. Phase 3: channels.route + persistence.appendChannelLog.
    throw new Error("mesh_send: not implemented (Phase 1)");
  },
};

export const meshGet = {
  name: "mesh_get",
  description:
    "Pull incoming messages — optionally filtered by channel and/or type. For fire-and-forget consumption (vs mesh_await's blocking wait).",
  parameters: Type.Object({
    channel: Type.Optional(Type.String({ description: 'Filter to a channel.' })),
    type: Type.Optional(Type.String({ description: 'Filter to a message type.' })),
    since: Type.Optional(Type.Number({ description: 'Only messages with ts > since (epoch ms).' })),
  }),
  async run(_args: { channel?: string; type?: MsgType; since?: number }, _ctx: unknown): Promise<MeshMsg[]> {
    throw new Error("mesh_get: not implemented (Phase 1)");
  },
};

export const meshAwait = {
  name: "mesh_await",
  description:
    "Block until a matching message arrives (e.g., await a dup_check_result from a peer), or the timeout expires. The synchronous round-trip primitive.",
  parameters: Type.Object({
    channel: Type.Optional(Type.String({ description: 'Await on this channel.' })),
    type: Type.Optional(Type.String({ description: 'Await a message of this type (e.g. "dup_check_result").' })),
    from: Type.Optional(Type.String({ description: 'Await a message from this specific peer.' })),
    timeoutMs: Type.Optional(Type.Number({ description: 'Timeout in ms (default 5000).' })),
  }),
  async run(_args: { channel?: string; type?: MsgType; from?: string; timeoutMs?: number }, _ctx: unknown): Promise<MeshMsg | undefined> {
    throw new Error("mesh_await: not implemented (Phase 1)");
  },
};

// ─── Phase 5: the fleet-state primitives (the "rich" layer) ────────────────

export const meshClaimTarget = {
  name: "mesh_claim_target",
  description:
    "Atomically claim a hunt target for this session. Other sessions see it via mesh_list + a 'claim' broadcast on #general. Prevents two sessions hunting the same target.",
  parameters: Type.Object({
    target: Type.String({ description: 'The hunt target to claim (e.g. "gmtrade").' }),
    scope: Type.Optional(Type.String({ description: 'Optional scope summary to share with the fleet.' })),
  }),
  async run(_args: { target: string; scope?: string }, _ctx: unknown): Promise<boolean> {
    throw new Error("mesh_claim_target: not implemented (Phase 5)");
  },
};

export const meshReleaseTarget = {
  name: "mesh_release_target",
  description: "Release a claimed target (on exit or handoff).",
  parameters: Type.Object({
    target: Type.String({ description: 'The target to release.' }),
  }),
  async run(_args: { target: string }, _ctx: unknown): Promise<void> {
    throw new Error("mesh_release_target: not implemented (Phase 5)");
  },
};

export const meshBankFinding = {
  name: "mesh_bank_finding",
  description:
    "Announce + persist a banked finding on #dup-check. Persists to fleet-state.jsonl (never lost). Other sessions' mesh_dup_check queries match against these.",
  parameters: Type.Object({
    target: Type.String({ description: 'The target the finding is on.' }),
    severity: Type.String({ description: 'Severity (e.g. "HIGH" / "Med").' }),
    title: Type.String({ description: 'Short finding title.' }),
    ref: Type.String({ description: 'Reference (file path / gist / report id).' }),
  }),
  async run(_args: { target: string; severity: string; title: string; ref: string }, _ctx: unknown): Promise<void> {
    throw new Error("mesh_bank_finding: not implemented (Phase 5)");
  },
};

export const meshDupCheck = {
  name: "mesh_dup_check",
  description:
    "Cross-hunt dup-check: broadcast a dup_check request on #dup-check + await the peers' dup_check_result responses. The killer feature for parallel bug-bounty (live cross-hunt dup-check before submitting).",
  parameters: Type.Object({
    target: Type.String({ description: 'The target the candidate finding is on.' }),
    title: Type.String({ description: 'The candidate finding title.' }),
    rootCause: Type.String({ description: 'The root-cause summary (for overlap matching).' }),
    timeoutMs: Type.Optional(Type.Number({ description: 'Await timeout in ms (default 5000).' })),
  }),
  async run(_args: { target: string; title: string; rootCause: string; timeoutMs?: number }, _ctx: unknown): Promise<Array<{ from: string; overlap: boolean; note?: string }>> {
    throw new Error("mesh_dup_check: not implemented (Phase 5)");
  },
};

export const meshHandoff = {
  name: "mesh_handoff",
  description:
    "Announce a session-handoff pointer on #handoff (persists so the next session + the peers know where to resume).",
  parameters: Type.Object({
    target: Type.String({ description: 'The target being handed off.' }),
    handoffPath: Type.String({ description: 'Path to the handoff file.' }),
  }),
  async run(_args: { target: string; handoffPath: string }, _ctx: unknown): Promise<void> {
    throw new Error("mesh_handoff: not implemented (Phase 5)");
  },
};

export const meshFleetState = {
  name: "mesh_fleet_state",
  description:
    "Read the durable fleet-state ledger — all claims, findings, handoffs, dup-checks. The persisted snapshot of the fleet (survives restarts; the durable HUNT-FLEET.md layer, structured + typed).",
  parameters: Type.Object({}),
  async run(_args: Record<string, never>, _ctx: unknown): Promise<FleetState> {
    throw new Error("mesh_fleet_state: not implemented (Phase 5)");
  },
};

export const meshChannels = {
  name: "mesh_channels",
  description: "List channels + their live subscriber counts + whether they persist to disk.",
  parameters: Type.Object({}),
  async run(_args: Record<string, never>, _ctx: unknown): Promise<Channel[]> {
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