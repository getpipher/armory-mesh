// armory-mesh — Phase 6.5 smoke: mesh relay + hub failover + cross-machine late-joiner replay.
//   1. Mesh relay (hub-less cross-machine, loop-prevention): A can't reach C directly (partitioned)
//      → A relays via B → C receives. Loop-prevention: a relay to an undeliverable target bounces
//      up to maxHops then drops (visited-set + hop-count) — no infinite loop, no crash.
//   2. Hub failover: two hubs (hub1, hub2). A + B discover + round-trip via hub1; stop hub1 → both
//      rotate to hub2 (after failoverThreshold SSE failures) + round-trip again.
//   3. Cross-machine late-joiner replay: A broadcasts a #dup-check finding while alone (no peer
//      online) → the hub stores it. B starts later → the hub replays the history → B receives it
//      (the 02:00→09:00 cross-machine scenario).
// Run: `pnpm test:smoke6_5` (jiti). Hubs run in-process (createHubServer).

import { createMeshCore } from "../src/mesh.js";
import { createHubServer } from "../src/hub.js";
import { MESH_ROOT, paths } from "../src/paths.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PING_MS = 100;
const EVICTION = 3;
const MAX_HOPS = 2;
const FAILOVER_THRESHOLD = 1; // rotate after 1 SSE failure (fast for the test)
let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function peer(n: string, host?: string) {
  const id = crypto.randomUUID();
  return { id, name: n, model: "m", host: host ?? n + "-host", lastSeen: Date.now(), alive: true } as const;
}
function localCfg(project: string, n: string, overrides: Record<string, unknown> = {}) {
  return {
    project, agentName: n, pingMs: PING_MS, evictionMisses: EVICTION,
    maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: MAX_HOPS,
    persistChannels: ["#dup-check", "#handoff", "#general"], maxChannelLogBytes: 10 * 1024 * 1024,
    ...overrides,
  } as const;
}
function hubCfg(project: string, n: string, hubUrls: string[], overrides: Record<string, unknown> = {}) {
  return {
    project, agentName: n, pingMs: PING_MS, evictionMisses: EVICTION,
    maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: MAX_HOPS,
    persistChannels: ["#dup-check", "#handoff", "#general", "#learnings"], maxChannelLogBytes: 10 * 1024 * 1024,
    hubUrls, authToken: "hub-test-token",
    hubFailoverThreshold: FAILOVER_THRESHOLD,
    ...overrides,
  } as const;
}
function rmProj(p: string) { fs.rmSync(path.join(MESH_ROOT, p), { recursive: true, force: true }); }

// ── 1. Mesh relay (hub-less cross-machine, loop-prevention) ──────────────────
async function testRelay(): Promise<void> {
  const PROJECT = "smoke-phase6_5-relay";
  console.log("armory-mesh — Phase 6.5 smoke test\nSection 1: mesh relay (hub-less cross-machine, loop-prevention)\n");
  rmProj(PROJECT);
  const A_id = crypto.randomUUID(), B_id = crypto.randomUUID(), C_id = crypto.randomUUID();
  // A is partitioned from C (can't reach C directly — e.g. C is on another machine in a git-synced
  // local-mode registry). B bridges both. C is reachable normally from B.
  const A = await createMeshCore({
    config: localCfg(PROJECT, "alpha", { unreachablePeers: [C_id] }) as any,
    self: { id: A_id, name: "alpha", model: "m", host: "h1", socketPath: paths.socket(PROJECT, A_id), lastSeen: Date.now(), alive: true },
  });
  const B = await createMeshCore({
    config: localCfg(PROJECT, "beta") as any,
    self: { id: B_id, name: "beta", model: "m", host: "h1", socketPath: paths.socket(PROJECT, B_id), lastSeen: Date.now(), alive: true },
  });
  const C = await createMeshCore({
    config: localCfg(PROJECT, "gamma") as any,
    self: { id: C_id, name: "gamma", model: "m", host: "h2", socketPath: paths.socket(PROJECT, C_id), lastSeen: Date.now(), alive: true },
  });
  await A.start(); await sleep(150);
  await B.start(); await sleep(150);
  await C.start(); await sleep(250);

  console.log("Criterion 1: A relays a targeted message to C via B (A partitioned from C)");
  const id = await A.send({ target: C_id, type: "text", payload: { via: "relay" } });
  check("send returned an id", typeof id === "string");
  await sleep(250);
  const got = await C.get({});
  check("C received the relayed message (A → B → C)", got.length === 1 && (got[0].payload as { via: string }).via === "relay", `C got ${got.length}`);
  check("B did NOT queue the in-transit relay frame", (await B.get({})).length === 0, "B queued the transit frame (should have relayed, not queued)");

  console.log(`Criterion 2: loop-prevention — a relay to an undeliverable target drops at maxHops (${MAX_HOPS}) (no hang, no crash)`);
  const ghost = "00000000-0000-0000-0000-000000000000";
  const t0 = Date.now();
  let threw = false;
  try {
    // A can't reach ghost directly → relays via B; B can't reach ghost → re-relays to C; C can't
    // reach ghost → hops(2) >= maxHops(2) → drop. A's send resolves (the first relay leg succeeded).
    await A.send({ target: ghost, type: "text", payload: "loop-test" });
  } catch { threw = true; }
  await sleep(300);
  const elapsed = Date.now() - t0;
  check("send to undeliverable target did not hang (>5s would indicate a loop)", elapsed < 5000, `took ${elapsed}ms`);
  check("send to undeliverable target did not throw (relay leg succeeded)", !threw);
  check("C did not receive the loop-test message", (await C.get({})).every((m) => (m.payload as { via?: string } | string)?.via !== "loop-test" && m.payload !== "loop-test"));

  await A.stop(); await B.stop(); await C.stop();
  rmProj(PROJECT);
}

// ── 2. Hub failover ──────────────────────────────────────────────────────────
async function testFailover(): Promise<void> {
  const PROJECT = "smoke-phase6_5-failover";
  console.log("\nSection 2: hub failover (standby hub + client fail-over)\n");
  rmProj(PROJECT);
  const TOKEN = "hub-test-token";
  const hub1 = createHubServer({ authToken: TOKEN, port: 0, pingMs: PING_MS, evictionMisses: EVICTION });
  const hub2 = createHubServer({ authToken: TOKEN, port: 0, pingMs: PING_MS, evictionMisses: EVICTION });
  await hub1.start();
  await hub2.start();
  const hub1Url = `http://localhost:${hub1.port}`;
  const hub2Url = `http://localhost:${hub2.port}`;
  console.log(`  hub1 on ${hub1Url}  ·  hub2 on ${hub2Url}`);

  const A = await createMeshCore({ config: hubCfg(PROJECT, "alpha", [hub1Url, hub2Url]) as any, self: peer("alpha"), getCtxUsage: () => 10 });
  const B = await createMeshCore({ config: hubCfg(PROJECT, "beta", [hub1Url, hub2Url]) as any, self: peer("beta"), getCtxUsage: () => 20 });
  await A.start(); await sleep(200);
  await B.start(); await sleep(400);

  console.log("Criterion 1: A + B discover + round-trip via hub1");
  const aPeers = await A.list();
  check("A sees B via hub1", aPeers.some((p) => p.id === B.self.id), `A sees: ${aPeers.map((p) => p.name).join(",") || "nobody"}`);
  await A.send({ target: B.self.id, type: "text", payload: "ping1" });
  await sleep(200);
  const via1 = await B.get({});
  check("B received the message via hub1", via1.some((m) => m.payload === "ping1"), `B got ${via1.length} msgs`);

  console.log(`Criterion 2: stop hub1 → both fail over to hub2 (after ${FAILOVER_THRESHOLD} SSE failure) + round-trip via hub2`);
  await hub1.stop();
  await sleep(1000 + 600); // reconnect delay (1s) + re-join/discover propagation
  // Both should now be registered on hub2 + discoverable.
  const aPeers2 = await A.list();
  check("A sees B via hub2 after failover", aPeers2.some((p) => p.id === B.self.id), `A sees: ${aPeers2.map((p) => p.name).join(",") || "nobody"}`);
  await A.send({ target: B.self.id, type: "text", payload: "via-hub2" });
  await sleep(300);
  const via2 = await B.get({});
  check("B received the message via hub2 after failover", via2.some((m) => m.payload === "via-hub2"), `B got ${via2.length} msgs`);

  await A.stop(); await B.stop();
  await hub2.stop();
  rmProj(PROJECT);
}

// ── 3. Cross-machine late-joiner replay (hub-stored logs) ─────────────────────
async function testReplay(): Promise<void> {
  const PROJECT = "smoke-phase6_5-replay";
  console.log("\nSection 3: cross-machine late-joiner replay (hub-stored logs)\n");
  rmProj(PROJECT);
  const TOKEN = "hub-test-token";
  const hub = createHubServer({
    authToken: TOKEN, port: 0, pingMs: PING_MS, evictionMisses: EVICTION,
    persistChannels: ["#dup-check", "#general", "#handoff", "#learnings"],
  });
  await hub.start();
  const hubUrl = `http://localhost:${hub.port}`;
  console.log(`  hub on ${hubUrl} (persistChannels: #dup-check, #general, #handoff, #learnings)`);

  // A broadcasts a #dup-check finding while ALONE (no peer online). The hub stores it.
  const A = await createMeshCore({ config: hubCfg(PROJECT, "alpha", [hubUrl]) as any, self: peer("alpha"), getCtxUsage: () => 10 });
  await A.start(); await sleep(200);
  console.log("Criterion 1: A broadcasts a #dup-check finding while alone → the hub stores it");
  await A.send({ channel: "#dup-check", type: "finding", payload: { target: "gmtrade", severity: "HIGH", title: "replay-test-finding", ref: "src/x.ts" } });
  await sleep(300);
  check("A's alone broadcast did not throw + completed", true);

  // B starts LATER — joins with no cursors → the hub replays the persisted #dup-check history.
  console.log("Criterion 2: B starts later → the hub replays the history → B receives the finding");
  const B = await createMeshCore({ config: hubCfg(PROJECT, "beta", [hubUrl]) as any, self: peer("beta"), getCtxUsage: () => 20 });
  await B.start();
  await sleep(500); // allow the hub's replay frames to arrive + process
  const got = await B.get({ channel: "#dup-check" });
  check("B received the replayed #dup-check finding from the hub", got.some((m) => m.type === "finding" && (m.payload as { title: string }).title === "replay-test-finding"), `B got ${got.length} msgs`);
  check("the replayed message carries a verified signature", got.some((m) => m.sig.length === 64 && m.nonce > 0));

  console.log("Criterion 3: a SECOND late-joiner with a cursor does NOT re-receive the old finding");
  // C starts with a cursor at now (simulating it already saw everything up to this point).
  const beforeC = Date.now() + 1;
  const C = await createMeshCore({ config: hubCfg(PROJECT, "gamma", [hubUrl]) as any, self: peer("gamma"), getCtxUsage: () => 30 });
  // Inject a fresh cursor file so C's join carries a cursor past the finding's ts.
  const cursorsDir = path.join(MESH_ROOT, PROJECT, "cursors");
  fs.mkdirSync(cursorsDir, { recursive: true });
  fs.writeFileSync(path.join(cursorsDir, `${C.self.id}.json`), JSON.stringify({ "#dup-check": beforeC, "#general": beforeC, "#handoff": beforeC, "#learnings": beforeC }));
  await C.start();
  await sleep(500);
  const gotC = await C.get({ channel: "#dup-check" });
  check("C (with a forward cursor) did NOT receive the old finding", gotC.every((m) => (m.payload as { title?: string })?.title !== "replay-test-finding"), `C got ${gotC.length} msgs`);

  await A.stop(); await B.stop(); await C.stop();
  await hub.stop();
  rmProj(PROJECT);
}

async function main(): Promise<void> {
  try {
    await testRelay();
    await testFailover();
    await testReplay();
  } catch (err) {
    failures++;
    console.error(`\n💥 uncaught error: ${err instanceof Error ? err.stack : String(err)}`);
  }
  console.log("");
  if (failures === 0) { console.log("✅ Phase 6.5 smoke test PASSED (all criteria)"); process.exit(0); }
  else { console.error(`❌ Phase 6.5 smoke test FAILED (${failures} check(s))`); process.exit(1); }
}

void main();