// armory-mesh — public type declarations.
// SCAFFOLD (Phase 0). The tool signatures are sketched; refine as the implementation lands.

/** A live peer in the mesh pool. */
export interface Peer {
  id: string;            // stable agent id (the socket/registry key)
  name: string;          // human-readable agent name
  model: string;         // the model the session is running
  host: string;          // machine hostname (for cross-host awareness)
  socketPath?: string;   // local Unix socket (local mode)
  contextUsage?: number; // 0..1 — live context-window usage (the awareness signal)
  claimedTarget?: string; // the hunt target this session claimed, if any
  channels?: string[];  // channels this peer is subscribed to (Phase 3 routing)
  lastSeen: number;      // epoch ms of last heartbeat
  alive: boolean;        // liveness (false => pending eviction)
}

/** The typed message kinds. */
export type MsgType =
  | "heartbeat"
  | "claim"
  | "release"
  | "finding"
  | "dup_check"
  | "dup_check_result"
  | "scope"
  | "learning"
  | "handoff"
  | "text";

/** A mesh message (signed + replay-protected on the wire). */
export interface MeshMsg {
  id: string;            // msg id (returned by mesh_send)
  from: string;          // sender agent id
  to?: string;           // target agent id (undefined => channel broadcast)
  channel?: string;      // channel/topic (e.g. "#dup-check")
  type: MsgType;
  payload: unknown;
  nonce: number;         // per-sender monotonic (replay protection)
  sig: string;           // HMAC-SHA256 over {project, from, channel, type, nonce, payload}
  ts: number;            // epoch ms
}

/** A cursor into a channel's persisted log (for late-joiner replay). */
export interface Cursor {
  channel: string;
  seq: number;           // the last-seen message sequence in that channel
}

/** A fleet-state entry (persisted to fleet-state.jsonl). */
export type FleetStateEntry =
  | { kind: "claim"; target: string; session: string; scope?: string; ts: number }
  | { kind: "release"; target: string; session: string; ts: number }
  | { kind: "finding"; target: string; session: string; severity: string; title: string; ref: string; ts: number }
  | { kind: "handoff"; target: string; session: string; handoffPath: string; ts: number }
  | { kind: "dup_check"; target: string; session: string; title: string; rootCause: string; results: Array<{ from: string; overlap: boolean; note?: string }>; ts: number };

/** The full fleet state (the durable ledger). */
export interface FleetState {
  project: string;
  entries: FleetStateEntry[];
}

/** A channel + its live subscriber count. */
export interface Channel {
  name: string;
  subscribers: number;
  persisted: boolean; // whether this channel logs to disk
}