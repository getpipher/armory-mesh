// armory-mesh — the unified transport (local Unix socket ↔ remote hub, same API).
// SCAFFOLD (Phase 0). Phase 1: local Unix socket. Phase 6: hub + auto-selection.
// See DESIGN.md §3.1 + ROADMAP.md Phase 1 / Phase 6.

import type { Transport, Frame } from "./types.js";

/**
 * Phase 1: local Unix-socket transport.
 * - listen on paths.socket(project, agentId) (Windows: named pipe).
 * - connect to a peer's socket to send.
 * - length-prefixed JSON framing; cap frames at config.maxMessageBytes.
 * - the 256KB per-message cap is enforced here (drop + log on oversized).
 *
 * Phase 6: unified auto-selection — if a peer's host != this host, route via the hub
 * (HTTP+SSE) instead of the Unix socket. The tool API (mesh_send etc.) is identical.
 */
export function createLocalTransport(opts: { project: string; agentId: string }): Transport {
  // TODO(Phase 1): implement.
  void opts;
  throw new Error("createLocalTransport: not implemented (Phase 1)");
}

/**
 * Phase 6: the remote hub transport. Connects to PI_MESH_HUB_URL (HTTP+SSE);
 * messages relay through the hub. Requires PI_MESH_AUTH_TOKEN for LAN.
 */
export function createHubTransport(opts: { hubUrl: string; authToken?: string }): Transport {
  // TODO(Phase 6): implement.
  void opts;
  throw new Error("createHubTransport: not implemented (Phase 6)");
}

/**
 * Phase 6: mesh relay — if a peer is unreachable directly, ask a reachable peer to relay.
 * Visited-set + hop-count (config.maxHops) prevent loops.
 */
export function relay(_frame: Frame, _via: string, _hops: number): Promise<void> {
  // TODO(Phase 6): implement. Reject if hops >= config.maxHops or the via-peer is in the visited-set.
  throw new Error("relay: not implemented (Phase 6)");
}