// armory-mesh — Phase 2 smoke test.
// Verifies the Phase-2 done-criteria (liveness + auto-eviction + the live pool widget):
//   1. Heartbeat broadcast carries live context-window usage (A sees B's ctx%, B sees A's ctx%).
//   2. Gossip eviction: a crashed peer's live card is dropped from snapshotPeers after the window.
//   3. The pool widget render surfaces peers + context usage + liveness (and "solo" when alone).
//   4. mesh_list returns the live merged view (registry discovery + live heartbeat cards).
//
// Run: `pnpm test:smoke2` (jiti resolves the .js→.ts imports).

import { createMeshCore, setMesh } from "../src/mesh.js";
import { paths, MESH_ROOT } from "../src/paths.js";
import { renderMeshPool } from "../extensions/mesh.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT = "smoke-phase2";
const PING_MS = 100;
const EVICTION_MISSES = 3;
const MAX_BYTES = 256 * 1024;
const projectDir = path.join(MESH_ROOT, PROJECT);

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function peer(name: string) {
  const id = crypto.randomUUID();
  return { id, name, model: "test-model", host: os.hostname(), socketPath: paths.socket(PROJECT, id), lastSeen: Date.now(), alive: true } as const;
}

function cfg(agentName: string) {
  return {
    project: PROJECT, agentName, pingMs: PING_MS, evictionMisses: EVICTION_MISSES,
    maxMessageBytes: MAX_BYTES, channelRatePerSec: 10, maxHops: 8, persistChannels: [],
  } as const;
}

async function main(): Promise<void> {
  console.log("armory-mesh — Phase 2 smoke test\n");
  fs.rmSync(projectDir, { recursive: true, force: true });

  // Simulated context-window usage (a live reader would call ctx.getContextUsage()).
  let aCtx = 42;
  let bCtx = 7;

  const A = await createMeshCore({ config: cfg("alpha") as any, self: peer("alpha"), getCtxUsage: () => aCtx });
  const B = await createMeshCore({ config: cfg("beta") as any, self: peer("beta"), getCtxUsage: () => bCtx });
  await Promise.all([A.start(), B.start()]);
  setMesh(A); setMesh(B);

  console.log("Criterion 1: heartbeat broadcasts live context-window usage");
  await sleep(PING_MS * 3 + 80); // a few heartbeat cycles so cards propagate
  const aSnap = A.snapshotPeers();
  const bSnap = B.snapshotPeers();
  const aSeesB = aSnap.find((p) => p.id === B.self.id);
  const bSeesA = bSnap.find((p) => p.id === A.self.id);
  check("A's snapshot includes B", !!aSeesB, `A sees: ${aSnap.map((p) => p.name).join(",") || "nobody"}`);
  check("B's snapshot includes A", !!bSeesA, `B sees: ${bSnap.map((p) => p.name).join(",") || "nobody"}`);
  check("A sees B's live context usage (≈7%)", aSeesB?.contextUsage === 7, `got ${aSeesB?.contextUsage}`);
  check("B sees A's live context usage (≈42%)", bSeesA?.contextUsage === 42, `got ${bSeesA?.contextUsage}`);

  console.log("Criterion 4: mesh_list returns the live merged view");
  const liveList = await A.list();
  check("mesh_list includes B with live ctx%", !!liveList.find((p) => p.id === B.self.id && p.contextUsage === 7));

  // Context usage changes are reflected on the next heartbeat.
  console.log("Criterion 1b: context-usage changes propagate");
  bCtx = 88;
  await sleep(PING_MS * 2 + 80);
  const aSnap2 = A.snapshotPeers();
  check("A sees B's updated context usage (88%)", aSnap2.find((p) => p.id === B.self.id)?.contextUsage === 88, `got ${aSnap2.find((p) => p.id === B.self.id)?.contextUsage}`);

  console.log("Criterion 3: pool widget render surfaces peers + context usage + liveness");
  const lines = renderMeshPool(80, { fg: (_r: string, t: string) => t }, A);
  check("widget header names the project + peer count", lines.some((l) => l.includes("mesh smoke-phase2") && l.includes("1 peer")));
  check("widget row shows B's name + ctx%", lines.some((l) => l.includes("beta") && l.includes("ctx:88")), `lines: ${JSON.stringify(lines)}`);

  console.log(`Criterion 2: gossip eviction after window (${PING_MS}ms × ${EVICTION_MISSES} = ${PING_MS * EVICTION_MISSES}ms)`);
  await B.crash(); // stops B's heartbeat (no graceful leave); B's live card goes silent
  await sleep(PING_MS * EVICTION_MISSES + 200);
  const after = A.snapshotPeers();
  check("A's live snapshot no longer shows B (gossip eviction)", !after.some((p) => p.id === B.self.id), `A sees: ${after.map((p) => p.name).join(",") || "nobody"}`);

  console.log("Criterion 3b: widget renders 'solo' when no peers");
  const solo = renderMeshPool(80, { fg: (_r: string, t: string) => t }, A);
  check("widget shows 'solo' when alone", solo.some((l) => l.includes("solo")), `lines: ${JSON.stringify(solo)}`);

  await A.stop();
  fs.rmSync(projectDir, { recursive: true, force: true });

  console.log("");
  if (failures === 0) { console.log("✅ Phase 2 smoke test PASSED (all criteria)"); process.exit(0); }
  else { console.error(`❌ Phase 2 smoke test FAILED (${failures} check(s) failed)`); process.exit(1); }
}

void main();