// armory-mesh — internal types (the wire + the transport).
// SCAFFOLD (Phase 0). The public types live in index.d.ts.

import type { MeshMsg, MsgType, Peer, Cursor } from "./index.js";

/** A frame on the wire (length-prefixed JSON, capped at MeshConfig.maxMessageBytes). */
export interface Frame {
  kind: "msg" | "ping" | "pong" | "join" | "leave" | "replay" | "replay-resp";
  msg?: MeshMsg;
  peer?: Peer;
  cursor?: Cursor;
  cursors?: Cursor[]; // for replay-resp
  msgs?: MeshMsg[];   // for replay-resp / replay (replayed history)
  channel?: string;  // for replay (which channel the msgs belong to)
  err?: string;
  // Phase 6.5: mesh-relay metadata (TRANSPORT-LEVEL, NOT part of the signed MeshMsg — a relay peer
  // forwards the original signed message untouched; the visited-set + hop-count prevent loops).
  // `to` is the final destination agent id (== msg.to). `visited` is the set of peer ids that have
  // already handled this frame (senders + prior relays) — a relay peer must NOT re-relay to anyone
  // in visited. `hops` counts relay legs; capped at MeshConfig.maxHops (hard drop — loop-prevention).
  relay?: { hops: number; visited: string[]; to: string };
}

/** The unified transport abstraction (local Unix socket OR remote hub — same API). */
export interface Transport {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(to: string, frame: Frame): Promise<void>;
  broadcast(channel: string, frame: Frame): Promise<void>;
  onFrame(handler: (frame: Frame, fromTransport: string) => void | Promise<void>): void;
}

export type MsgTypeGuard = (m: MeshMsg) => boolean;