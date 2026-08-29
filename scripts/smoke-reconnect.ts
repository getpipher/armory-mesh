// armory-mesh — reconnect smoke: proves the same-hub SSE gap is back-filled (the handoff's
// last open Known Issue) and that a connection blip doesn't corrupt registry presence.
//   1. Gap back-fill: B's SSE drops (hub.closeConnections) → A broadcasts on a persisted channel
//      during the gap → B reconnects with LIVE cursors → the hub replays exactly the gap →
//      B receives each gap message EXACTLY ONCE (cursor-suppressed history + markSeen dedup),
//      no re-delivery of pre-gap messages, and the live path still works after the replay.
//   2. Wi-fi blip: after a connection teardown + reconnect, the hub does NOT evict the (still-
//      heartbeating) peer, A's registry view survives, and targeted sends flow both ways again.
// Run: `pnpm test:smoke-reconnect` (jiti). Hub runs in-process (createHubServer).

import { createMeshCore } from "../src/mesh.js";
import { createHubServer } from "../src/hub.js";
import { MESH_ROOT, paths } from "../src/paths.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PING_MS = 100;
const RECONNECT_DELAY = 1000 + 1200; // transport's fixed 1s reconnect timer + replay/processing margin
let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function peer(n: string) {
  const id = crypto.randomUUID();
  return { id, name: n, model: "m", host: `${n}-host`, lastSeen: Date.now(), alive: true } as const;
}
function hubCfg(project: string, n: string, hubUrls: string[], overrides: Record<string, unknown> = {}) {
  return {
    project, agentName: n, pingMs: PING_MS, evictionMisses: 30,
    maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: 8,
    persistChannels: ["#dup-check", "#handoff", "#general", "#learnings"], maxChannelLogBytes: 10 * 1024 * 1024,
    hubUrls, authToken: "hub-test-token",
    ...overrides,
  } as const;
}
function rmProj(p: string) { fs.rmSync(path.join(MESH_ROOT, p), { recursive: true, force: true }); }

/** Drain a peer's inbound queue until empty; return the payloads (strings) received. */
async function drain(core: ReturnType<typeof createMeshCore>, filter: Record<string, unknown> = {}): Promise<string[]> {
  const out: string[] = [];
  for (;;) {
    const msgs = await core.get(filter);
    if (msgs.length === 0) break;
    for (const m of msgs) out.push(typeof m.payload === "string" ? m.payload : JSON.stringify(m.payload));
  }
  return out;
}

/** Drain until the queue stays empty for `quietMs` (reconnect + replay can lag on a loaded
 *  machine — a single drain raced it in CI-style loops). Caps at `maxWait`. */
async function drainQuiet(core: ReturnType<typeof createMeshCore>, quietMs = 600, maxWait = 8000): Promise<string[]> {
  const out: string[] = [];
  const deadline = Date.now() + maxWait;
  let lastNew = Date.now();
  while (Date.now() < deadline && Date.now() - lastNew < quietMs) {
    await sleep(150);
    const batch = await drain(core);
    if (batch.length > 0) { out.push(...batch); lastNew = Date.now(); }
  }
  return out;
}

// ── 1. Same-hub SSE gap back-fill (live cursors + replay + dedup) ────────────
async function testGapBackfill(): Promise<void> {
  const PROJECT = "smoke-reconnect-gap";
  console.log("armory-mesh — reconnect smoke\nSection 1: same-hub SSE gap back-fill (live cursors, exactly-once)\n");
  rmProj(PROJECT);
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-hub-store-")), "store.ndjson");
  const hub = createHubServer({ authToken: "hub-test-token", port: 0, pingMs: PING_MS, evictionMisses: 30, storePath });
  await hub.start();
  const hubUrl = `http://localhost:${hub.port}`;

  const A = await createMeshCore({ config: hubCfg(PROJECT, "alpha", [hubUrl]) as any, self: peer("alpha"), getCtxUsage: () => 10 });
  const B = await createMeshCore({ config: hubCfg(PROJECT, "beta", [hubUrl]) as any, self: peer("beta"), getCtxUsage: () => 20 });
  await A.start(); await sleep(200);
  await B.start(); await sleep(400);
  check("A + B discovered each other via the hub", (await A.list()).some((p) => p.id === B.self.id));

  // Baseline: B receives msg1 live (this also sets B's cursor).
  await A.send({ channel: "#dup-check", type: "text", payload: "msg1-baseline" });
  await sleep(300);
  const baseline = await drain(B);
  check("baseline: B received msg1 live", baseline.includes("msg1-baseline"), `got ${JSON.stringify(baseline)}`);

  // Kill every client connection (SSE + in-flight POST sockets). The hub stays up; clients
  // schedule reconnect (~1s). A short pause lets undici discard the destroyed sockets so A's
  // next POST /send rides a fresh one.
  hub.closeConnections();
  await sleep(150);

  // The GAP: two broadcasts must land in the hub's channel log while B's SSE is down. The
  // teardown instant can eat the first POST even with the transport's single retry (undici's
  // pool needs a moment to settle), so re-send each message until the disk-backed store acks it
  // — the store IS the durability proof. A silently-dropped send then fails HERE, precisely.
  const gapDeadline = Date.now() + 5000;
  let persisted = false;
  while (Date.now() < gapDeadline) {
    const raw = fs.existsSync(storePath) ? fs.readFileSync(storePath, "utf-8") : "";
    if (raw.includes("msg2-gap") && raw.includes("msg3-gap")) { persisted = true; break; }
    try { if (!raw.includes("msg2-gap")) await A.send({ channel: "#dup-check", type: "text", payload: "msg2-gap" }); } catch { /* rate-capped — the loop retries */ }
    try { if (!raw.includes("msg3-gap")) await A.send({ channel: "#dup-check", type: "text", payload: "msg3-gap" }); } catch { /* rate-capped — the loop retries */ }
    await sleep(200);
  }
  check("gap messages persisted to the hub store", persisted);
  console.log("  gap: msg2 + msg3 sent while B's SSE was down (store-acked)");

  // B reconnects (1s timer) → POST /join with live cursors → hub replays exactly the gap.
  await sleep(RECONNECT_DELAY);
  const afterReconnect = await drainQuiet(B);
  check("B received the gap message msg2 exactly once", afterReconnect.filter((p) => p === "msg2-gap").length === 1, `got ${JSON.stringify(afterReconnect)}`);
  check("B received the gap message msg3 exactly once", afterReconnect.filter((p) => p === "msg3-gap").length === 1, `got ${JSON.stringify(afterReconnect)}`);
  check("B did NOT re-receive the pre-gap msg1 (cursor suppression + dedup)", !afterReconnect.includes("msg1-baseline"), `got ${JSON.stringify(afterReconnect)}`);
  check("B's reconnect delivery was exactly the gap (nothing extra)", afterReconnect.length === 2, `got ${JSON.stringify(afterReconnect)}`);

  // The live path still works after the replay (post-reconnect send arrives once, not replayed).
  await A.send({ target: B.self.id, type: "text", payload: "msg4-live-after" }); // no channel → live-only
  await sleep(300);
  const afterLive = await drainQuiet(B);
  check("B received the post-reconnect live send exactly once", afterLive.filter((p) => p === "msg4-live-after").length === 1, `got ${JSON.stringify(afterLive)}`);

  await A.stop(); await B.stop();
  await hub.stop();
  fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
  rmProj(PROJECT);
}

// ── 2. Wi-fi blip: teardown + reconnect must not corrupt registry presence ───
async function testWifiBlip(): Promise<void> {
  const PROJECT = "smoke-reconnect-blip";
  console.log("\nSection 2: wi-fi blip — connection teardown without eviction (registry survives)\n");
  rmProj(PROJECT);
  const hub = createHubServer({ authToken: "hub-test-token", port: 0, pingMs: PING_MS, evictionMisses: 30, storePath: "off" });
  await hub.start();
  const hubUrl = `http://localhost:${hub.port}`;

  const A = await createMeshCore({ config: hubCfg(PROJECT, "alpha", [hubUrl]) as any, self: peer("alpha"), getCtxUsage: () => 10 });
  const B = await createMeshCore({ config: hubCfg(PROJECT, "beta", [hubUrl]) as any, self: peer("beta"), getCtxUsage: () => 20 });
  await A.start(); await sleep(200);
  await B.start(); await sleep(400);
  check("A + B discovered each other via the hub", (await A.list()).some((p) => p.id === B.self.id));

  hub.closeConnections();
  await sleep(RECONNECT_DELAY);

  // B kept heartbeating (registry POSTs are independent of the SSE stream) → the hub must NOT
  // have evicted it, and A's view must still name it after both clients reconnected.
  const aSees = await A.list();
  check("A still sees B after the blip (no false eviction)", aSees.some((p) => p.id === B.self.id), `A sees: ${aSees.map((p) => p.name).join(",") || "nobody"}`);
  const bSees = await B.list();
  check("B still sees A after the blip", bSees.some((p) => p.id === A.self.id), `B sees: ${bSees.map((p) => p.name).join(",") || "nobody"}`);

  // Live sends flow both ways again over the reconnected SSE streams.
  await B.send({ target: A.self.id, type: "text", payload: "blip-b2a" });
  await sleep(300);
  check("targeted B→A works after the blip", (await drainQuiet(A)).includes("blip-b2a"));
  await A.send({ channel: "#general", type: "text", payload: "blip-a2b" });
  await sleep(300);
  check("broadcast A→B works after the blip", (await drainQuiet(B)).includes("blip-a2b"));

  await A.stop(); await B.stop();
  await hub.stop();
  rmProj(PROJECT);
}

// ── 3. Hub restart: the disk-backed store survives the process ──────────────
async function testHubRestart(): Promise<void> {
  const PROJECT = "smoke-reconnect-hubrestart";
  console.log("\nSection 3: hub restart — late-joiner replay survives the process (disk-backed store)");
  rmProj(PROJECT);
  const TOKEN = "hub-test-token";
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-hub-store-")), "store.ndjson");
  const hubCfgRestart = { authToken: TOKEN, port: 0, pingMs: PING_MS, evictionMisses: 30, storePath };

  // Generation 1: A banks a finding while alone → the hub stores it (buffer + disk), then "dies".
  const hub1 = createHubServer(hubCfgRestart);
  await hub1.start();
  const A = await createMeshCore({ config: hubCfg(PROJECT, "alpha", [`http://localhost:${hub1.port}`]) as any, self: peer("alpha"), getCtxUsage: () => 10 });
  await A.start(); await sleep(200);
  await A.send({ channel: "#dup-check", type: "finding", payload: { target: "gmtrade", severity: "HIGH", title: "survives-hub-restart", ref: "src/x.ts" } });
  await sleep(300); // give the async appendFile time to land
  const storeRaw = fs.readFileSync(storePath, "utf-8");
  check("generation 1: the store file exists on disk + holds the finding", storeRaw.includes("survives-hub-restart"), `store=${storePath}`);
  await A.stop();
  await hub1.stop(); // the in-memory buffer is gone from here on — only the disk remains

  // Generation 2: a NEW hub process (same storePath) hydrates from disk; a fresh peer joins
  // with no cursors → it must still receive the pre-restart finding.
  const hub2 = createHubServer(hubCfgRestart);
  await hub2.start();
  const B = await createMeshCore({ config: hubCfg(PROJECT, "beta", [`http://localhost:${hub2.port}`]) as any, self: peer("beta"), getCtxUsage: () => 20 });
  await B.start();
  await sleep(500);
  const got = await drain(B);
  check("generation 2: the fresh peer received the pre-restart finding from the restarted hub", got.some((p) => p.includes("survives-hub-restart")), `got ${JSON.stringify(got)}`);

  await B.stop();
  await hub2.stop();
  fs.rmSync(path.dirname(storePath), { recursive: true, force: true });
  rmProj(PROJECT);
}

async function main(): Promise<void> {
  try {
    await testGapBackfill();
    await testWifiBlip();
    await testHubRestart();
  } catch (err) {
    failures++;
    console.error(`\n💥 uncaught error: ${err instanceof Error ? err.stack : String(err)}`);
  }
  console.log("");
  if (failures === 0) { console.log("✅ reconnect smoke PASSED (all criteria)"); process.exit(0); }
  else { console.error(`❌ reconnect smoke FAILED (${failures} check(s))`); process.exit(1); }
}

void main();
