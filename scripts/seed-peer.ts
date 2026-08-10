// Seed peer for the Phase-2 TUI smoke: joins the mesh as "beta" + stays alive so a real pi
// session (alpha) can render the pool widget with a live peer. Exits after ~50s.
import { createMeshCore } from "../src/mesh.js";
import { paths } from "../src/paths.js";
import os from "node:os";
import crypto from "node:crypto";

const PROJECT = process.env.PI_MESH_PROJECT ?? "tui-smoke";
const id = crypto.randomUUID();
const self = {
  id, name: "beta", model: "glm-5.2:cloud", host: os.hostname(),
  socketPath: paths.socket(PROJECT, id), contextUsage: 33, lastSeen: Date.now(), alive: true,
};
const cfg = {
  project: PROJECT, agentName: "beta", pingMs: 1000, evictionMisses: 5,
  maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: 8, persistChannels: [],
};
const core = await createMeshCore({ config: cfg as any, self, getCtxUsage: () => 33 });
await core.start();
console.error(`seed peer beta joined ${PROJECT} (${id.slice(0, 8)})`);
// Keep alive for 50s so the TUI session can observe the widget.
await new Promise((r) => setTimeout(r, 50_000));
await core.stop();