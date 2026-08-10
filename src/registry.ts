// armory-mesh — the peer registry (cross-host, liveness-aware).
// See DESIGN.md §3.2 + ROADMAP.md.
//
// Phase 1: local file registry at paths.agentRegistry(project)/<id>.json. Each agent writes its own
// file on join + touches lastSeen on every heartbeat (see MeshCore). refreshPool() re-reads + evicts
// stale entries (lastSeen older than evictionMisses * pingMs) — the coms stale-registry gap closed.
// Phase 6: in hub mode the hub holds the live registry; agents fetch on join + heartbeat.

import fs from "node:fs/promises";
import path from "node:path";
import type { Peer } from "./index.js";
import { paths } from "./paths.js";

export interface Registry {
  join(self: Peer): Promise<void>;
  leave(): Promise<void>;
  list(): Promise<Peer[]>; // all registered peers (raw read; no eviction)
  refreshPool(): Promise<Peer[]>; // re-read + evict stale; live peers only (alive === true)
  heartbeat(): Promise<void>; // rewrite self's file with lastSeen=now
  updateContext(usage: number | undefined): Promise<void>; // broadcast own context-window usage (Phase 2)
  updateSelf(patch: Partial<Peer>): Promise<void>; // general self-field update (Phase 3: channels)
  updateClaim(target: string | undefined): Promise<void>; // the claimed-target field (Phase 5)
  selfId: string;
}

export function createRegistry(opts: { project: string; agentId: string; pingMs: number; evictionMisses: number }): Registry {
  const { project, agentId, pingMs, evictionMisses } = opts;
  let self: Peer | null = null;
  const staleAfterMs = pingMs * evictionMisses;

  async function writeSelf(patch: Partial<Peer>): Promise<void> {
    if (!self) throw new Error("registry: not joined");
    const next: Peer = { ...self, ...patch, lastSeen: Date.now() };
    self = next;
    await fs.writeFile(paths.agentFile(project, agentId), JSON.stringify(next), "utf-8");
  }

  async function join(s: Peer): Promise<void> {
    self = s;
    await fs.mkdir(paths.agentRegistry(project), { recursive: true });
    await fs.mkdir(paths.socketDir(project), { recursive: true });
    await fs.writeFile(paths.agentFile(project, agentId), JSON.stringify(s), "utf-8");
  }

  async function leave(): Promise<void> {
    try {
      await fs.unlink(paths.agentFile(project, agentId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    self = null;
  }

  async function readDir(): Promise<Peer[]> {
    const dir = paths.agentRegistry(project);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const peers: Peer[] = [];
    await Promise.all(
      entries
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          try {
            const raw = await fs.readFile(path.join(dir, f), "utf-8");
            const p = JSON.parse(raw) as Peer;
            if (p && typeof p.id === "string") peers.push(p);
          } catch {
            // corrupt/unreadable entry — skip (don't poison the pool)
          }
        }),
    );
    return peers;
  }

  async function list(): Promise<Peer[]> {
    return readDir();
  }

  async function refreshPool(): Promise<Peer[]> {
    const all = await readDir();
    const now = Date.now();
    const live: Peer[] = [];
    await Promise.all(
      all.map(async (p) => {
        // Never evict self (its heartbeat may have lagged mid-startup).
        if (p.id === agentId) {
          live.push({ ...p, alive: true });
          return;
        }
        if (now - (p.lastSeen ?? 0) > staleAfterMs) {
          // stale → evict the dead registry file so it doesn't ghost the pool
          try {
            await fs.unlink(paths.agentFile(project, p.id));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              // best-effort; don't let a failed unlink block the pool refresh
            }
          }
        } else {
          live.push({ ...p, alive: true });
        }
      }),
    );
    return live;
  }

  async function heartbeat(): Promise<void> {
    await writeSelf({}); // bumps lastSeen only
  }

  async function updateContext(usage: number | undefined): Promise<void> {
    await writeSelf({ contextUsage: usage });
  }

  async function updateSelf(patch: Partial<Peer>): Promise<void> {
    await writeSelf(patch);
  }

  async function updateClaim(target: string | undefined): Promise<void> {
    await writeSelf({ claimedTarget: target });
  }

  return { join, leave, list, refreshPool, heartbeat, updateContext, updateSelf, updateClaim, selfId: agentId };
}