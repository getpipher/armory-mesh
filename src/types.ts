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
  msgs?: MeshMsg[];   // for replay-resp (replayed history)
  err?: string;
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