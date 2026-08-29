// armory-mesh — config (env vars + defaults) + project-scoped mesh config discovery.
// Used from Phase 1 on. Phase 8: .pi/mesh.json ancestor-walk (findMeshConfig/findMeshConfigPath).

import fs from "node:fs";
import path from "node:path";

export interface MeshConfig {
  project: string;            // the project pool (peers in the same project discover each other)
  agentName: string;          // this session's display name
  hubUrl?: string;            // if set, use the remote hub; else local Unix sockets
  hubUrls?: string[];         // Phase 6.5: hub failover chain (tried in order on repeated failure). Overrides hubUrl if set.
  authToken?: string;         // PI_MESH_AUTH_TOKEN (required for LAN hub)
  pingMs: number;             // heartbeat interval
  evictionMisses: number;     // missed pings before a peer is evicted
  maxMessageBytes: number;    // per-message size cap
  channelRatePerSec: number;  // per-channel rate cap
  maxHops: number;            // mesh relay hop limit (loop-prevention)
  persistChannels: string[];  // channels that log to disk (opt-in)
  maxChannelLogBytes: number; // per-channel log rotation threshold
  // Phase 6.5: peer ids this session CANNOT reach directly (e.g. peers on another machine in a
  // git-synced local-mode registry — their socketPath resolves but the Unix socket is unreachable).
  // `send({target})` skips the direct attempt + relays via a live peer for these. Default: none.
  unreachablePeers?: string[];
  // Phase 6.5: after this many consecutive SSE failures against the current hub, fail over to the
  // next hub in hubUrls. Default 3.
  hubFailoverThreshold?: number;
}

/**
 * Phase 8: find the nearest-ancestor `.pi/mesh.json` from `dir` (inclusive). Project-scoped fleet
 * config: a workspace root drops ONE file and every session fired in any child folder joins the
 * same mesh pool — cross-hunt dup-check with zero env vars. Returns the FILE PATH of the nearest
 * VALID mesh.json (malformed files are skipped — the walk continues) or null.
 * (Precedence for the project id lives at the caller: PI_MESH_PROJECT env > mesh.json > cwd basename.)
 */
export function findMeshConfigPath(dir: string): string | null {
  let cur = dir;
  for (;;) {
    const p = path.join(cur, ".pi", "mesh.json");
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return p;
      } catch {
        // malformed mesh.json — skip it, keep walking up
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Read + validate the nearest-ancestor `.pi/mesh.json` (null when none is valid). */
export function findMeshConfig(dir: string): Record<string, unknown> | null {
  const p = findMeshConfigPath(dir);
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export const defaultMeshConfig = (overrides: Partial<MeshConfig> = {}): MeshConfig => ({
  project: process.env.PI_MESH_PROJECT ?? "default",
  agentName: process.env.PI_MESH_AGENT_NAME ?? "agent",
  hubUrl: process.env.PI_MESH_HUB_URL,            // undefined => local mode
  hubUrls: process.env.PI_MESH_HUB_URLS ? process.env.PI_MESH_HUB_URLS.split(",").filter(Boolean) : undefined,
  authToken: process.env.PI_MESH_AUTH_TOKEN,      // required for LAN hub
  pingMs: Number(process.env.PI_MESH_PING_MS) || 2000,
  evictionMisses: Number(process.env.PI_MESH_EVICTION_MISSES) || 5,
  maxMessageBytes: Number(process.env.PI_MESH_MAX_MESSAGE_BYTES) || 256 * 1024,
  channelRatePerSec: Number(process.env.PI_MESH_CHANNEL_RATE_PER_SEC) || 10,
  maxHops: Number(process.env.PI_MESH_MAX_HOPS) || 8,
  persistChannels: (process.env.PI_MESH_PERSIST_CHANNELS ?? "#dup-check,#handoff,#general").split(",").filter(Boolean),
  maxChannelLogBytes: Number(process.env.PI_MESH_MAX_CHANNEL_LOG_BYTES) || 10 * 1024 * 1024,
  unreachablePeers: process.env.PI_MESH_UNREACHABLE_PEERS ? process.env.PI_MESH_UNREACHABLE_PEERS.split(",").filter(Boolean) : undefined,
  hubFailoverThreshold: Number(process.env.PI_MESH_HUB_FAILOVER_THRESHOLD) || 3,
  ...overrides,
});