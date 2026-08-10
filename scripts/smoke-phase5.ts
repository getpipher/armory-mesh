// armory-mesh — Phase 5 smoke: the fleet-state primitives (claim/bank/dup-check/handoff).
//   1. Atomic claim: first writer wins; a second claimant loses (sees the holder via mesh_list).
//   2. Release + reclaim; stale-claim reclaim (a crashed session's claim is reclaimable).
//   3. Bank a finding + cross-hunt dup-check: a peer with the matching finding responds overlap=true.
//   4. Dup-check with no overlap: the responder says overlap=false.
//   5. Handoff: announced on #handoff + persisted to the ledger.
//   6. The fleet-state ledger (fleet-state.jsonl) records every primitive (write-through).
// Run: `pnpm test:smoke5` (jiti).

import { createMeshCore } from "../src/mesh.js";
import { readFleetState } from "../src/persistence.js";
import { paths, MESH_ROOT } from "../src/paths.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT = "smoke-phase5";
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
  return { id, name: n, model: "m", host: os.hostname(), socketPath: paths.socket(PROJECT, id), lastSeen: Date.now(), alive: true } as const;
}
function cfg(n: string) {
  return {
    project: PROJECT, agentName: n, pingMs: PING_MS, evictionMisses: EVICTION,
    maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: 8,
    persistChannels: ["#dup-check", "#handoff", "#general"], maxChannelLogBytes: 10 * 1024 * 1024,
  } as const;
}

async function main(): Promise<void> {
  console.log("armory-mesh — Phase 5 smoke test\n");
  fs.rmSync(projectDir, { recursive: true, force: true });

  const A = await createMeshCore({ config: cfg("alpha") as any, self: peer("alpha") });
  const B = await createMeshCore({ config: cfg("beta") as any, self: peer("beta") });
  const C = await createMeshCore({ config: cfg("gamma") as any, self: peer("gamma") });
  await Promise.all([A.start(), B.start(), C.start()]);
  await sleep(300);

  // ── 1. Atomic claim ───────────────────────────────────────────────────
  console.log("Criterion 1: atomic claim — first writer wins, second loses");
  const won1 = await A.claimTarget("gmtrade", "perps");
  check("A wins the first claim", won1);
  const won2 = await B.claimTarget("gmtrade");
  check("B loses the second claim (A holds it)", won2 === false);
  await sleep(150); // let A's claimed-target gossip via heartbeat
  const bView = B.snapshotPeers().find((p) => p.id === A.self.id);
  check("B sees A's claimed target via mesh_list", bView?.claimedTarget === "gmtrade", `got ${bView?.claimedTarget}`);
  check("claim file holds A's session", JSON.parse(fs.readFileSync(paths.claimFile(PROJECT, "gmtrade"), "utf-8")).session === A.self.id);

  // ── 2. Release + reclaim; stale reclaim ───────────────────────────────
  console.log("Criterion 2: release + reclaim; stale-claim reclaim after a crash");
  await A.releaseTarget("gmtrade");
  check("claim file removed on release", !fs.existsSync(paths.claimFile(PROJECT, "gmtrade")));
  const won3 = await B.claimTarget("gmtrade");
  check("B reclaims after A releases", won3);
  await B.releaseTarget("gmtrade");
  // Stale reclaim: A claims, crashes (no release) → B reclaims once A is evicted.
  await A.claimTarget("gmtrade2");
  await A.crash();
  await sleep(PING_MS * EVICTION + 200); // past the eviction window
  const won4 = await B.claimTarget("gmtrade2");
  check("B reclaims a stale claim after A crashes", won4, "B could not reclaim");

  // ── 3. Bank a finding + cross-hunt dup-check (overlap) ──────────────────
  console.log("Criterion 3: bank a finding + cross-hunt dup-check detects overlap");
  await A.bankFinding("gmtrade", "HIGH", "reentrancy", "src/x.sol");
  await sleep(150); // let A's ledger + the #dup-check broadcast land
  // A is crashed above — restart a fresh A' so it holds the finding + responds to dup_checks.
  const A2 = await createMeshCore({ config: cfg("alpha2") as any, self: peer("alpha2") });
  await A2.start();
  await sleep(250);
  await A2.bankFinding("gmtrade", "HIGH", "reentrancy", "src/x.sol"); // A2 banks the same finding in its ledger
  await sleep(150);
  const results = await B.dupCheck("gmtrade", "reentrancy", "unchecked external call", 2000);
  const a2Result = results.find((r) => r.from === A2.self.id);
  check("B's dup-check got a response from A2", results.length >= 1, `got ${results.length}`);
  check("A2 reports overlap=true (it has the matching finding)", a2Result?.overlap === true, `A2 overlap=${a2Result?.overlap}`);

  // ── 4. Dup-check with no overlap ───────────────────────────────────────
  console.log("Criterion 4: dup-check with no overlap → responder says overlap=false");
  const noResults = await C.dupCheck("gmtrade", "totally-different-finding", "some-other-root", 1500);
  check("C's dup-check got responses", noResults.length >= 1, `got ${noResults.length}`);
  check("responders report overlap=false for a non-matching candidate", noResults.every((r) => r.overlap === false), JSON.stringify(noResults));

  // ── 5. Handoff ─────────────────────────────────────────────────────────
  console.log("Criterion 5: handoff announced on #handoff + persisted");
  await A2.handoff("gmtrade", "/tmp/handoff-gmtrade.md");
  await sleep(150);
  const bHandoff = await B.get({ channel: "#handoff" });
  check("B received the handoff broadcast on #handoff", bHandoff.length === 1 && (bHandoff[0].payload as { handoffPath: string }).handoffPath === "/tmp/handoff-gmtrade.md", `B got ${bHandoff.length}`);

  // ── 6. The fleet-state ledger ──────────────────────────────────────────
  console.log("Criterion 6: fleet-state.jsonl records every primitive (write-through)");
  const ledger = await readFleetState(PROJECT);
  const kinds = new Set(ledger.map((e) => e.kind));
  check("ledger has a claim entry", kinds.has("claim"));
  check("ledger has a release entry", kinds.has("release"));
  check("ledger has a finding entry", kinds.has("finding"));
  check("ledger has a dup_check entry", kinds.has("dup_check"));
  check("ledger has a handoff entry", kinds.has("handoff"));
  const dupEntries = ledger.filter((e) => e.kind === "dup_check");
  check("dup_check entry carries its results", dupEntries.length > 0 && Array.isArray((dupEntries[0] as { results: unknown[] }).results) && (dupEntries[0] as { results: unknown[] }).results.length >= 1);

  await B.stop(); await C.stop(); await A2.stop();
  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log("");
  if (failures === 0) { console.log("✅ Phase 5 smoke test PASSED (all criteria)"); process.exit(0); }
  else { console.error(`❌ Phase 5 smoke test FAILED (${failures} check(s))`); process.exit(1); }
}

void main();