// armory-mesh — Phase 6 smoke: the remote hub (HTTP+SSE relay + shared registry).
//   1. Two hub-mode cores discover each other via the hub (SSE peer-joined events + /join registry).
//   2. mesh_send round-trips through the hub (signed + verified); broadcast reaches subscribers.
//   3. Auth gate: a request without/wrong PI_MESH_AUTH_TOKEN is rejected (401).
//   4. Hub-side liveness eviction: a crashed peer (no heartbeat) is evicted → mesh_list drops it.
// Run: `pnpm test:smoke6` (jiti). The hub runs in-process (createHubServer).

import { createMeshCore } from "../src/mesh.js";
import { createHubServer } from "../src/hub.js";
import { paths, MESH_ROOT } from "../src/paths.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT = "smoke-phase6";
const TOKEN = "hub-test-token-" + crypto.randomUUID();
const PING_MS = 100;
const EVICTION = 3;
const projectDir = path.join(MESH_ROOT, PROJECT);

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function peer(n: string) {
  const id = crypto.randomUUID();
  // Hub mode: no local socket needed (the hub relays). socketPath left undefined.
  return { id, name: n, model: "m", host: n + "-host", lastSeen: Date.now(), alive: true } as const;
}
function cfg(n: string, hubUrl: string) {
  return {
    project: PROJECT, agentName: n, pingMs: PING_MS, evictionMisses: EVICTION,
    maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: 8,
    persistChannels: [], maxChannelLogBytes: 10 * 1024 * 1024,
    hubUrl, authToken: TOKEN,
  } as const;
}

async function main(): Promise<void> {
  console.log("armory-mesh — Phase 6 smoke test\n");
  fs.rmSync(projectDir, { recursive: true, force: true });

  // Start the hub in-process on an ephemeral port.
  const hub = createHubServer({ authToken: TOKEN, port: 0, pingMs: PING_MS, evictionMisses: EVICTION });
  await hub.start();
  const hubUrl = `http://localhost:${hub.port}`;
  console.log(`  hub on ${hubUrl}`);

  const A = await createMeshCore({ config: cfg("alpha", hubUrl) as any, self: peer("alpha"), getCtxUsage: () => 10 });
  const B = await createMeshCore({ config: cfg("beta", hubUrl) as any, self: peer("beta"), getCtxUsage: () => 20 });
  await A.start();
  await sleep(200);
  await B.start();

  // ── 1. Discovery via the hub ──────────────────────────────────────────
  console.log("Criterion 1: two hub-mode cores discover each other via the hub");
  await sleep(500); // let /join + SSE peer-joined propagate
  const aPeers = await A.list();
  const bPeers = await B.list();
  check("A sees B", aPeers.some((p) => p.id === B.self.id), `A sees: ${aPeers.map((p) => p.name).join(",") || "nobody"}`);
  check("B sees A", bPeers.some((p) => p.id === A.self.id), `B sees: ${bPeers.map((p) => p.name).join(",") || "nobody"}`);
  check("A sees B's live context usage (20%)", aPeers.find((p) => p.id === B.self.id)?.contextUsage === 20, `got ${aPeers.find((p) => p.id === B.self.id)?.contextUsage}`);

  // ── 2. Send round-trip + broadcast through the hub ─────────────────────
  console.log("Criterion 2: mesh_send round-trips through the hub (signed + verified); broadcast reaches subscribers");
  const id = await A.send({ target: B.self.id, type: "text", payload: { hello: "hub" } });
  check("send returned an id", typeof id === "string");
  await sleep(200);
  const got = await B.get({});
  check("B received the targeted message via the hub", got.length === 1 && (got[0].payload as { hello: string }).hello === "hub", `B got ${got.length}`);
  check("message carries a verified signature (sig + nonce)", got.length === 1 && got[0].sig.length === 64 && got[0].nonce > 0);
  await A.send({ channel: "#general", type: "text", payload: "fleet-broadcast" });
  await sleep(200);
  const bc = await B.get({ channel: "#general" });
  check("B received the #general broadcast via the hub", bc.length === 1 && bc[0].payload === "fleet-broadcast", `B got ${bc.length}`);

  // ── 3. Auth gate ───────────────────────────────────────────────────────
  console.log("Criterion 3: auth gate — requests without/wrong PI_MESH_AUTH_TOKEN are rejected (401)");
  const noToken = await fetch(hubUrl + "/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "rogue", peer: peer("rogue") }) });
  check("no token → 401", noToken.status === 401, `got ${noToken.status}`);
  const wrongToken = await fetch(hubUrl + "/join", { method: "POST", headers: { "content-type": "application/json", "x-mesh-token": "wrong" }, body: JSON.stringify({ agentId: "rogue", peer: peer("rogue") }) });
  check("wrong token → 401", wrongToken.status === 401, `got ${wrongToken.status}`);
  const goodToken = await fetch(hubUrl + "/join", { method: "POST", headers: { "content-type": "application/json", "x-mesh-token": TOKEN }, body: JSON.stringify({ agentId: "rogue", peer: peer("rogue") }) });
  check("correct token → 200", goodToken.status === 200, `got ${goodToken.status}`);

  // ── 4. Hub-side liveness eviction ──────────────────────────────────────
  console.log(`Criterion 4: hub-side eviction after window (${PING_MS}ms × ${EVICTION} = ${PING_MS * EVICTION}ms)`);
  await B.crash(); // stops B's heartbeat (no /leave); the hub evicts B after the window
  await sleep(PING_MS * EVICTION + 400);
  const after = await A.list();
  check("A no longer sees B after the hub evicts it (no ghost)", !after.some((p) => p.id === B.self.id), `A sees: ${after.map((p) => p.name).join(",") || "nobody"}`);

  await A.stop();
  await hub.stop();
  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log("");
  if (failures === 0) { console.log("✅ Phase 6 smoke test PASSED (all criteria)"); process.exit(0); }
  else { console.error(`❌ Phase 6 smoke test FAILED (${failures} check(s))`); process.exit(1); }
}

void main();