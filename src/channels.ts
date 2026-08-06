// armory-mesh — channels (topics) + typed messages.
// SCAFFOLD (Phase 0). Phase 3: channels + typed message validation + routing.
// See DESIGN.md §3.4.

import type { MeshMsg, MsgType, Channel } from "./index.js";

/** The default channels per project (created on join). Plus per-target channels on demand. */
export const DEFAULT_CHANNELS = ["#general", "#dup-check", "#learnings", "#handoff", "#heartbeats"] as const;

/** Phase 3: validate a message's type against its payload shape. */
export function validateType(type: MsgType, payload: unknown): string[] {
  // TODO(Phase 3): per-type payload validation (e.g. "finding" requires {target, severity, title, ref}).
  //   Return a list of validation errors ([] = valid).
  void type; void payload;
  return [];
}

/** Phase 3: channel registry — who subscribes, who persists. */
export interface ChannelRegistry {
  join(channel: string): void;
  leave(channel: string): void;
  list(): Channel[];
  subscribers(channel: string): number;
}

export function createChannelRegistry(opts: { persistChannels: string[] }): ChannelRegistry {
  // TODO(Phase 3): implement. persisted channels log to paths.channelLog (see persistence.ts).
  void opts;
  throw new Error("createChannelRegistry: not implemented (Phase 3)");
}

/** Phase 3: route a message — to a specific peer (msg.to set) or all channel subscribers (msg.channel set). */
export function route(_msg: MeshMsg): { targetPeers: string[] } {
  // TODO(Phase 3): resolve the subscriber list for msg.channel (or the single msg.to).
  throw new Error("route: not implemented (Phase 3)");
}