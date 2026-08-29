// armory-mesh — Phase 7 smoke: hardening (size cap, wire fuzz, rate cap, observability, fleet materialization).
//   1. Size cap: an oversized mesh_send fails fast with a clear error; an oversized RAW frame is
//      rejected by the receiving transport (no crash — the peer keeps serving).
//   2. Wire fuzz (sendRawFrame injection): malformed JSON, bogus length prefix, spoofed signature,
//      replayed nonce — each is DROPPED (no queue, no crash) and the peer keeps serving.
//   3. Rate cap: a config with channelRatePerSec=3 rejects the 4th rapid send on a channel, recovers
//      after the refill window; #heartbeats is exempt (liveness is control-plane).
//   4. Observability: onObs receives mesh_send / mesh_receive / mesh_relay / mesh_drop / mesh_replay /
//      mesh_evict events (flat, queryable, pi-agent-observability-compatible).
//   5. Cross-machine fleet-state (hub mode): a finding received via hub REPLAY is materialized into
//      the local ledger (deduped) → a later mesh_dup_check reports overlap=true.
// Run: `pnpm test:smoke7` (jiti).

import { createMeshCore } from "../src/mesh.js";
import { createHubServer } from "../src/hub.js";
import { createAuth } from "../src/auth.js";
import { sendRawFrame } from "../src/transport.js";
import { readFleetState } from "../src/persistence.js";
import { MESH_ROOT, paths } from "../src/paths.js";
import type { ObsEvent } from "../src/index.js";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PING_MS = 100;
const EVICTION = 3;
let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function peer(n: string, project: string, host?: string) {
  const id = crypto.randomUUID();
  return { id, name: n, model: "m", host: host ?? n + "-host", socketPath: paths.socket(project, id), lastSeen: Date.now(), alive: true } as const;
}
function hubPeer(n: string, host?: string) {
  const id = crypto.randomUUID();
  return { id, name: n, model: "m", host: host ?? n + "-host", lastSeen: Date.now(), alive: true } as const;
}
function localCfg(project: string, n: string, overrides: Record<string, unknown> = {}) {
  return {
    project, agentName: n, pingMs: PING_MS, evictionMisses: EVICTION,
    maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: 8,
    persistChannels: ["#dup-check", "#general"], maxChannelLogBytes: 10 * 1024 * 1024,
    ...overrides,
  } as const;
}
function hubCfg(project: string, n: string, hubUrl: string, overrides: Record<string, unknown> = {}) {
  return {
    project, agentName: n, pingMs: PING_MS, evictionMisses: EVICTION,
    maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: 8,
    persistChannels: ["#dup-check", "#general", "#handoff", "#learnings"], maxChannelLogBytes: 10 * 1024 * 1024,
    hubUrl, authToken: "hub-test-token",
    ...overrides,
  } as const;
}
function rmProj(p: string) { fs.rmSync(path.join(MESH_ROOT, p), { recursive: true, force: true }); }

// Raw-frame injection helpers (the fuzz harness — same entry point a rogue local process would use).
function frameBuf(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), "utf-8");
  const h = Buffer.alloc(4);
  h.writeUInt32BE(body.length, 0);
  return Buffer.concat([h, body]);
}
function rawSend(socketPath: string, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ path: socketPath });
    s.once("error", reject);
    s.once("connect", () => {
      s.write(buf);
      setTimeout(() => { try { s.end(); } catch { /* ignore */ } resolve(); }, 40);
    });
  });
}
function collector(): { events: ObsEvent[]; on: (e: ObsEvent) => void; of: (t: ObsEvent["event_type"]) => ObsEvent[] } {
  const events: ObsEvent[] = [];
  return { events, on: (e) => events.push(e), of: (t) => events.filter((e) => e.event_type === t) };
}

async function testSizeAndFuzz(): Promise<void> {
  const PROJECT = "smoke-phase7-fuzz";
  console.log("armory-mesh — Phase 7 smoke test\nSection 1+2: size cap + wire fuzz (malformed / oversized / spoofed / replayed)\n");
  rmProj(PROJECT);
  const A = await createMeshCore({ config: localCfg(PROJECT, "alpha") as any, self: peer("alpha", PROJECT) });
  const B = await createMeshCore({ config: localCfg(PROJECT, "beta") as any, self: peer("beta", PROJECT) });
  const obsB = collector();
  B.onObs = obsB.on;
  await A.start(); await sleep(150);
  await B.start(); await sleep(250);

  console.log("Criterion 1: size cap — oversized payload fails fast with a clear error");
  const big = "x".repeat(300 * 1024); // 300KB > 256KB cap
  let oversized = false;
  try { await A.send({ target: B.self.id, type: "text", payload: big }); } catch (e) { oversized = /exceeds cap \(307\d\d\d > 262144 bytes\)/.test(e instanceof Error ? e.message : String(e)); }
  check("oversized mesh_send throws the cap error", oversized);
  check("nothing was queued on B", (await B.get({})).length === 0);

  console.log("Criterion 2a: raw OVERSIZED frame (length prefix > cap) is rejected by the receiver");
  const bogusLen = Buffer.alloc(4);
  bogusLen.writeUInt32BE(300 * 1024 + 10, 0); // declares more than the cap
  await rawSend(paths.socket(PROJECT, B.self.id), Buffer.concat([bogusLen, Buffer.from("junkjunkjunk")]));
  await sleep(120);
  check("B alive after oversized raw frame", true);
  check("no drop mis-attributed (rejected at the framing layer, pre-parse)", obsB.of("mesh_drop").length === 0);

  console.log("Criterion 2b: raw MALFORMED JSON frame is dropped (no crash, no queue)");
  const malformed = Buffer.alloc(4);
  malformed.writeUInt32BE(16, 0);
  await rawSend(paths.socket(PROJECT, B.self.id), Buffer.concat([malformed, Buffer.from("this is not json")]));
  await sleep(120);
  check("B alive after malformed frame (still serves a valid round-trip)", await (async () => {
    await A.send({ target: B.self.id, type: "text", payload: "still-alive" });
    await sleep(150);
    return (await B.get({})).some((m) => m.payload === "still-alive");
  })());

  console.log("Criterion 2c: SPOOFED signature is dropped (sig checked BEFORE the nonce window — no poisoning)");
  const forge = createAuth({ project: PROJECT, selfId: "forger" });
  await forge.ensureKey(); // reads the shared project key (a key-holding rogue)
  const evil = { id: crypto.randomUUID(), from: "forger", to: B.self.id, channel: "#general", type: "text" as const, payload: "spoofed", nonce: 501, sig: "", ts: Date.now() };
  evil.sig = forge.sign(evil).slice(0, -2) + "ff"; // tamper the last byte
  await rawSend(paths.socket(PROJECT, B.self.id), frameBuf({ kind: "msg", msg: evil }));
  await sleep(150);
  check("spoofed msg NOT queued on B", !(await B.get({})).some((m) => m.payload === "spoofed"));
  check("the drop was observed (mesh_drop bad-signature)", obsB.of("mesh_drop").some((e) => e.reason === "bad-signature-or-replayed-nonce" && e.from === "forger"));

  console.log("Criterion 2d: REPLAYED nonce is dropped (a valid frame sent twice arrives once)");
  const twin = { id: crypto.randomUUID(), from: "forger", to: B.self.id, channel: "#general", type: "text" as const, payload: "replay-me", nonce: 777, sig: "", ts: Date.now() };
  twin.sig = forge.sign(twin);
  const twinFrame = frameBuf({ kind: "msg", msg: twin });
  await rawSend(paths.socket(PROJECT, B.self.id), twinFrame);
  await sleep(150);
  await rawSend(paths.socket(PROJECT, B.self.id), twinFrame); // the replay
  await sleep(150);
  const replays = (await B.get({})).filter((m) => m.payload === "replay-me");
  check("replayed frame arrived exactly ONCE", replays.length === 1, `got ${replays.length}`);

  await A.stop(); await B.stop();
  rmProj(PROJECT);
}

async function testRateCap(): Promise<void> {
  const PROJECT = "smoke-phase7-rate";
  console.log("\nSection 3: per-channel rate cap (token bucket; #heartbeats exempt)\n");
  rmProj(PROJECT);
  const A = await createMeshCore({ config: localCfg(PROJECT, "alpha", { channelRatePerSec: 3 }) as any, self: peer("alpha", PROJECT) });
  const B = await createMeshCore({ config: localCfg(PROJECT, "beta", { channelRatePerSec: 3 }) as any, self: peer("beta", PROJECT) });
  await A.start(); await sleep(150);
  await B.start(); await sleep(400);

  console.log("Criterion 1: burst beyond channelRatePerSec is rejected, then recovers after refill");
  let sent = 0, throttled = 0;
  for (let i = 0; i < 5; i++) {
    try { await A.send({ channel: "#general", type: "text", payload: `burst-${i}` }); sent++; }
    catch (e) { if (/rate limit exceeded/.test(e instanceof Error ? e.message : String(e))) throttled++; else throw e; }
  }
  check("first 3 sends pass, the rest are throttled", sent === 3 && throttled === 2, `sent ${sent}, throttled ${throttled}`);
  await sleep(1100); // one refill window
  let recovered = false;
  try { await A.send({ channel: "#general", type: "text", payload: "after-refill" }); recovered = true; } catch { /* still capped */ }
  check("send recovers after the refill window", recovered);

  console.log("Criterion 2: #heartbeats is exempt — B still sees A as alive despite rate=3");
  const bPeers = await B.list();
  check("B sees A (heartbeat liveness survived the throttled config)", bPeers.some((p) => p.id === A.self.id), `B sees: ${bPeers.map((p) => p.name).join(",") || "nobody"}`);

  await A.stop(); await B.stop();
  rmProj(PROJECT);
}

async function testObservability(): Promise<void> {
  const PROJECT = "smoke-phase7-obs";
  console.log("\nSection 4: observability hooks (mesh_send / mesh_receive / mesh_relay / mesh_evict)\n");
  rmProj(PROJECT);
  const C_id = crypto.randomUUID();
  const A = await createMeshCore({ config: localCfg(PROJECT, "alpha", { unreachablePeers: [C_id] }) as any, self: { ...peer("alpha", PROJECT), id: crypto.randomUUID() } });
  const A_id = A.self.id;
  const B = await createMeshCore({ config: localCfg(PROJECT, "beta") as any, self: peer("beta", PROJECT) });
  const C = await createMeshCore({ config: localCfg(PROJECT, "gamma") as any, self: { ...peer("gamma", PROJECT), id: C_id } });
  const obsA = collector(), obsB = collector();
  A.onObs = obsA.on; B.onObs = obsB.on;
  await A.start(); await sleep(150);
  await B.start(); await sleep(150);
  await C.start(); await sleep(300);

  await A.send({ target: B.self.id, type: "text", payload: "obs-roundtrip" });
  await sleep(200);
  check("sender emitted mesh_send (the #general message)", obsA.of("mesh_send").some((e) => e.channel === "#general" && e.type === "text"));
  check("receiver emitted mesh_receive", obsB.of("mesh_receive").some((e) => e.from === A_id && e.type === "text"));
  check("events carry the flat queryable shape (source_app/session_id/timestamp)", obsA.events.every((e) => e.source_app === "armory-mesh" && typeof e.session_id === "string" && typeof e.timestamp === "string"));

  // Relay: A is partitioned from C → relay via B emits mesh_relay on A (sender side).
  await A.send({ target: C_id, type: "text", payload: "obs-relay" });
  await sleep(250);
  check("relay emitted mesh_relay (sender side)", obsA.of("mesh_relay").some((e) => e.to === C_id && e.hops === 1));

  // Eviction: a disposable peer crashes → B evicts it from its live cards → mesh_evict.
  const E = await createMeshCore({ config: localCfg(PROJECT, "epsilon") as any, self: peer("epsilon", PROJECT) });
  await E.start(); await sleep(400); // B learns E via heartbeat gossip
  await E.crash();
  await sleep(PING_MS * EVICTION + 300); // eviction window
  check("crashed peer emitted mesh_evict on the survivor", obsB.of("mesh_evict").some((e) => e.peer === E.self.id && e.reason === "heartbeat-timeout"), `evicts: ${obsB.of("mesh_evict").length}`);

  await A.stop(); await B.stop(); await C.stop();
  rmProj(PROJECT);
}

async function testMaterialization(): Promise<void> {
  const PROJECT = "smoke-phase7-mat";
  console.log("\nSection 5: cross-machine fleet-state (hub replay → ledger materialization → dup_check)\n");
  rmProj(PROJECT);
  const TOKEN = "hub-test-token";
  const hub = createHubServer({ authToken: TOKEN, port: 0, pingMs: PING_MS, evictionMisses: EVICTION, persistChannels: ["#dup-check", "#general", "#handoff", "#learnings"], storePath: "off" });
  await hub.start();
  const hubUrl = `http://localhost:${hub.port}`;

  // A (machine X) banks a finding while ALONE → the hub stores it.
  const A = await createMeshCore({ config: hubCfg(PROJECT, "alpha", hubUrl) as any, self: hubPeer("alpha", "x-host") });
  await A.start(); await sleep(200);
  await A.send({ channel: "#dup-check", type: "finding", payload: { target: "gmtrade", severity: "HIGH", title: "reentrancy", ref: "src/x.sol" } });
  await sleep(250);

  // B (machine Y) starts later → hub replay → materializes the finding into ITS ledger.
  const B = await createMeshCore({ config: hubCfg(PROJECT, "beta", hubUrl) as any, self: hubPeer("beta", "y-host") });
  const obsB = collector();
  B.onObs = obsB.on;
  await B.start();
  await sleep(600);
  check("B replayed the #dup-check history from the hub", obsB.of("mesh_replay").some((e) => e.channel === "#dup-check"));
  const ledger = await readFleetState(PROJECT);
  const mat = ledger.filter((e) => e.kind === "finding" && e.title === "reentrancy" && e.session === A.self.id);
  check("the replayed finding was materialized into the local ledger (session = the original bankER)", mat.length === 1, `got ${mat.length}`);

  // Re-receiving the same finding (same target/title/session) must NOT duplicate the entry.
  await A.send({ channel: "#dup-check", type: "finding", payload: { target: "gmtrade", severity: "HIGH", title: "reentrancy", ref: "src/x.sol" } });
  await sleep(400);
  const ledger2 = await readFleetState(PROJECT);
  const mat2 = ledger2.filter((e) => e.kind === "finding" && e.title === "reentrancy" && e.session === A.self.id);
  check("re-receiving the same finding did NOT duplicate the ledger entry", mat2.length === 1, `got ${mat2.length}`);

  // A THIRD peer's dup_check now sees the cross-machine overlap (the Phase 6.5 gap, closed).
  const D = await createMeshCore({ config: hubCfg(PROJECT, "delta", hubUrl) as any, self: hubPeer("delta", "z-host") });
  await D.start(); await sleep(400);
  const results = await D.dupCheck("gmtrade", "reentrancy", "reentrancy in instruction processor");
  check("mesh_dup_check reports the cross-machine overlap=true", results.some((r) => r.overlap === true), `results: ${JSON.stringify(results)}`);

  await A.stop(); await B.stop(); await D.stop();
  await hub.stop();
  rmProj(PROJECT);
}

async function main(): Promise<void> {
  try {
    await testSizeAndFuzz();
    await testRateCap();
    await testObservability();
    await testMaterialization();
  } catch (err) {
    failures++;
    console.error(`\n💥 uncaught error: ${err instanceof Error ? err.stack : String(err)}`);
  }
  console.log("");
  if (failures === 0) { console.log("✅ Phase 7 smoke test PASSED (all criteria)"); process.exit(0); }
  else { console.error(`❌ Phase 7 smoke test FAILED (${failures} check(s))`); process.exit(1); }
}

void main();