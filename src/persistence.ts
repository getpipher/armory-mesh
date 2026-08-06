// armory-mesh — persistence + late-joiner replay (the durable ledger).
// SCAFFOLD (Phase 0). Phase 4: optional per-channel ndjson logs + cursor replay + the always-persisted fleet-state.jsonl.
// See DESIGN.md §3.5.

import type { MeshMsg, Cursor } from "./index.js";
import { paths } from "./paths.js";

/**
 * Phase 4: append a message to a channel's ndjson log (if the channel is in config.persistChannels).
 * Rotated by size. Append-only (never mutate the log).
 */
export async function appendChannelLog(project: string, msg: MeshMsg): Promise<void> {
  // TODO(Phase 4): fs.promises.appendFile(paths.channelLog(project, msg.channel), JSON.stringify(msg) + "\n")
  void project; void msg;
  throw new Error("appendChannelLog: not implemented (Phase 4)");
}

/**
 * Phase 4: cursor-based replay — on join, a peer sends its last-seen cursor per channel; the log-holder
 * (or the hub) replays from there. A session that starts at 09:00 catches up on the 02:00 finding broadcast.
 */
export async function replayFromCursor(project: string, cursor: Cursor): Promise<MeshMsg[]> {
  // TODO(Phase 4): stream paths.channelLog(project, cursor.channel), filter seq > cursor.seq.
  void project; void cursor;
  throw new Error("replayFromCursor: not implemented (Phase 4)");
}

/**
 * Phase 4: the always-persisted fleet-state ledger. claims/findings/handoffs/dup-checks write-through here
 * (even if channel messaging is ephemeral, fleet state is never lost). This is the persisted HUNT-FLEET.md layer,
 * but structured + typed.
 */
export async function appendFleetState<T extends { ts: number }>(project: string, entry: T): Promise<void> {
  // TODO(Phase 4): fs.promises.appendFile(paths.fleetState(project), JSON.stringify(entry) + "\n")
  void project; void entry;
  throw new Error("appendFleetState: not implemented (Phase 4)");
}

export async function readFleetState(project: string): Promise<unknown[]> {
  // TODO(Phase 4): stream + parse paths.fleetState(project).
  void project;
  throw new Error("readFleetState: not implemented (Phase 4)");
}

void paths; // paths.channelLog / paths.fleetState