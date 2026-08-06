// armory-mesh — the peer registry (cross-host, liveness-aware).
// SCAFFOLD (Phase 0). Phase 1: local file registry. Phase 2: liveness + eviction. Phase 6: hub-held shared registry.
// See DESIGN.md §3.2 + ROADMAP.md.

import type { Peer } from "./index.js";
import { paths } from "./paths.js";

/**
 * Phase 1: local file registry at paths.agentRegistry(project)/<id>.json.
 * Each agent writes its own file on join; updates the heartbeat on each ping; removes on graceful leave.
 *
 * Phase 2: liveness — scan the registry on each ping; a peer whose lastSeen is older than
 *   evictionMisses * pingMs is marked alive=false + evicted (the coms stale-registry gap closed).
 *
 * Phase 6: cross-host — in hub mode, the hub holds the live registry; agents fetch on join + on heartbeat.
 *   In hub-less mode, the registry file is git-syncable for cross-host discovery.
 */
export interface Registry {
  join(self: Peer): Promise<void>;
  leave(): Promise<void>;
  list(): Promise<Peer[]>;          // live peers only (alive === true)
  refreshPool(): Promise<Peer[]>;   // re-read + evict stale (Phase 2)
  updateContext(usage: number): Promise<void>; // broadcast own context-window usage (Phase 2)
  updateClaim(target: string | undefined): Promise<void>; // the claimed-target field (Phase 5)
}

export function createRegistry(opts: { project: string; agentId: string }): Registry {
  // TODO(Phase 1): implement. Use paths.agentFile(project, agentId) for self; read the dir for others.
  void opts;
  throw new Error("createRegistry: not implemented (Phase 1)");
}

void paths; // referenced for the layout (paths.agentRegistry / agentFile / socket)