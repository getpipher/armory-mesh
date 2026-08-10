// armory-mesh — the path layout for a project's mesh state.
// ~/.pi/mesh/<project>/  { key, allowlist.json, agents/<id>.json, sockets/<id>.sock, logs/<channel>.ndjson, fleet-state.jsonl }
// SCAFFOLD (Phase 0). Implemented in Phase 1.

import os from "node:os";
import path from "node:path";

export const MESH_ROOT = path.join(os.homedir(), ".pi", "mesh");

/** The per-project mesh directory. */
export function projectDir(project: string): string {
  return path.join(MESH_ROOT, encodeURIComponent(project));
}

export const paths = {
  key: (project: string) => path.join(projectDir(project), "key"),
  allowlist: (project: string) => path.join(projectDir(project), "allowlist.json"),
  agentRegistry: (project: string) => path.join(projectDir(project), "agents"),
  agentFile: (project: string, agentId: string) =>
    path.join(projectDir(project), "agents", `${agentId}.json`),
  socketDir: (project: string) => path.join(projectDir(project), "sockets"),
  socket: (project: string, agentId: string) =>
    path.join(projectDir(project), "sockets", `${agentId}.sock`),
  channelLog: (project: string, channel: string) =>
    path.join(projectDir(project), "logs", `${encodeURIComponent(channel)}.ndjson`),
  fleetState: (project: string) => path.join(projectDir(project), "fleet-state.jsonl"),
  claimsDir: (project: string) => path.join(projectDir(project), "claims"),
  claimFile: (project: string, target: string) =>
    path.join(projectDir(project), "claims", `${target.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
} as const;