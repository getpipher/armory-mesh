// armory-mesh — persistence + late-joiner replay (the durable ledger).
// See DESIGN.md §3.5.
//
// Phase 4 (local mode): the per-project channel logs at ~/.pi/mesh/<project>/logs/<channel>.ndjson
// are SHARED by all peers on the same machine (the filesystem is the shared bus). So a late-joiner
// catches up by reading the shared log from its last-seen cursor (no cross-peer round-trip — the
// `replay`/`replay-resp` Frame kinds are reserved for Phase 6 cross-machine hub mode). Appends use
// O_APPEND (atomic for ndjson lines < PIPE_BUF), so concurrent peers appending to the same log
// don't interleave lines. Rotation is by size (rename to .1, start fresh).
//
// The fleet-state ledger (~/.pi/mesh/<project>/fleet-state.jsonl) is ALWAYS persisted (the durable
// HUNT-FLEET.md layer). claims/findings/handoffs/dup-checks write-through here even if channel
// messaging is ephemeral — fleet state is never lost.

import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { MeshMsg, FleetStateEntry } from "./index.js";
import { paths, projectDir } from "./paths.js";

const LOG_ARCHIVE_SUFFIX = ".1";

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true }).catch(() => {});
}

/** Append a message to its channel's ndjson log if the channel is persisted. Rotate by size. */
export async function appendChannelLog(project: string, msg: MeshMsg, maxLogBytes: number): Promise<void> {
  if (!msg.channel) return;
  const file = paths.channelLog(project, msg.channel);
  await ensureDir(file);
  try {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.size > maxLogBytes) {
      // Rotate: move the current log to <channel>.ndjson.1 (overwrite any prior archive).
      try { await fs.rename(file, file + LOG_ARCHIVE_SUFFIX); } catch { /* best-effort */ }
    }
  } catch {
    // best-effort rotation
  }
  // O_APPEND: atomic for lines < PIPE_BUF (4KB on Linux/macOS). A MeshMsg line is well under that
  // for normal payloads; the transport's maxMessageBytes cap (256KB) bounds the worst case, but a
  // single oversized append could interleave under heavy concurrency — acceptable for Phase 4
  // (small fleet); Phase 7 hardening may add a per-channel write lock.
  await fs.appendFile(file, JSON.stringify(msg) + "\n", "utf-8");
}

/** Read a channel's log and return messages with ts > sinceTs (the late-joiner catch-up). */
export async function replayChannelFromTs(project: string, channel: string, sinceTs: number): Promise<MeshMsg[]> {
  const file = paths.channelLog(project, channel);
  let exists = false;
  try { await fs.access(file); exists = true; } catch { /* no log yet */ }
  if (!exists) return [];
  const out: MeshMsg[] = [];
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as MeshMsg;
        if (typeof msg.ts === "number" && msg.ts > sinceTs) out.push(msg);
      } catch {
        // skip malformed/interleaved line
      }
    }
  } finally {
    rl.close();
  }
  return out;
}

/** The always-persisted fleet-state ledger. Append-only ndjson. */
export async function appendFleetState(project: string, entry: FleetStateEntry): Promise<void> {
  const file = paths.fleetState(project);
  await ensureDir(file);
  await fs.appendFile(file, JSON.stringify(entry) + "\n", "utf-8");
}

/** Read the full fleet-state ledger (newest last). */
export async function readFleetState(project: string): Promise<FleetStateEntry[]> {
  const file = paths.fleetState(project);
  let exists = false;
  try { await fs.access(file); exists = true; } catch { /* no ledger yet */ }
  if (!exists) return [];
  const out: FleetStateEntry[] = [];
  const rl = readline.createInterface({ input: createReadStream(file, { encoding: "utf-8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as FleetStateEntry); } catch { /* skip malformed */ }
    }
  } finally {
    rl.close();
  }
  return out;
}

/** Per-agent cursor file: the last-seen ts per channel (so a restarted session resumes, not re-replays). */
function cursorFile(project: string, agentId: string): string {
  return path.join(projectDir(project), "cursors", `${agentId}.json`);
}

export async function loadCursors(project: string, agentId: string): Promise<Record<string, number>> {
  const file = cursorFile(project, agentId);
  try {
    const raw = await fs.readFile(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, number>;
  } catch { /* no cursor file yet (fresh session) */ }
  return {};
}

export async function saveCursors(project: string, agentId: string, cursors: Record<string, number>): Promise<void> {
  const file = cursorFile(project, agentId);
  await ensureDir(file);
  await fs.writeFile(file, JSON.stringify(cursors), "utf-8");
}