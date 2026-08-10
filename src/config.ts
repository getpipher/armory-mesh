// armory-mesh — config (env vars + defaults).
// SCAFFOLD (Phase 0). Used from Phase 1 on.

export interface MeshConfig {
  project: string;            // the project pool (peers in the same project discover each other)
  agentName: string;          // this session's display name
  hubUrl?: string;            // if set, use the remote hub; else local Unix sockets
  authToken?: string;         // PI_MESH_AUTH_TOKEN (required for LAN hub)
  pingMs: number;             // heartbeat interval
  evictionMisses: number;     // missed pings before a peer is evicted
  maxMessageBytes: number;    // per-message size cap
  channelRatePerSec: number;  // per-channel rate cap
  maxHops: number;            // mesh relay hop limit (loop-prevention)
  persistChannels: string[];  // channels that log to disk (opt-in)
  maxChannelLogBytes: number; // per-channel log rotation threshold
}

export const defaultMeshConfig = (overrides: Partial<MeshConfig> = {}): MeshConfig => ({
  project: process.env.PI_MESH_PROJECT ?? "default",
  agentName: process.env.PI_MESH_AGENT_NAME ?? "agent",
  hubUrl: process.env.PI_MESH_HUB_URL,            // undefined => local mode
  authToken: process.env.PI_MESH_AUTH_TOKEN,      // required for LAN hub
  pingMs: Number(process.env.PI_MESH_PING_MS) || 2000,
  evictionMisses: Number(process.env.PI_MESH_EVICTION_MISSES) || 5,
  maxMessageBytes: Number(process.env.PI_MESH_MAX_MESSAGE_BYTES) || 256 * 1024,
  channelRatePerSec: Number(process.env.PI_MESH_CHANNEL_RATE_PER_SEC) || 10,
  maxHops: Number(process.env.PI_MESH_MAX_HOPS) || 8,
  persistChannels: (process.env.PI_MESH_PERSIST_CHANNELS ?? "#dup-check,#handoff,#general").split(",").filter(Boolean),
  maxChannelLogBytes: Number(process.env.PI_MESH_MAX_CHANNEL_LOG_BYTES) || 10 * 1024 * 1024,
  ...overrides,
});