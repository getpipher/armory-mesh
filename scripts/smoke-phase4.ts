// armory-mesh — Phase 4 smoke: persistence + late-joiner replay + the fleet-state ledger.
//   1. Channel log write-through: a finding on a persisted channel lands in the shared ndjson log.
//   2. Late-joiner catch-up: a fresh peer that was offline when a finding was broadcast catches up
//      from the shared log on start (the 02:00 → 09:00 scenario).
//   3. Cursor resume: a peer that re-joins with the same id resumes from its saved cursor (no re-replay).
//   4. fleet-state.jsonl: the always-persisted durable ledger (append + read).
// Run: `pnpm test:smoke4` (jiti).

import { createMeshCore, setMesh, meshFleetState } from "../src/mesh.js";
import { appendFleetState, readFleetState } from "../src/persistence.js";
import { paths, MESH_ROOT } from "../src/paths.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT = "smoke-phase4";
const PING_MS = 100;
const projectDir = path.join(MESH_ROOT, PROJECT);

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function peer(name: string, id?: string) {
  const aid = id ?? crypto.randomUUID();
  return { id: aid, name, model: "m", host: os.hostname(), socketPath: paths.socket(PROJECT, aid), lastSeen: Date.now(), alive: true } as const;
}
function cfg(n: string) {
  return {
    project: PROJECT, agentName: n, pingMs: PING_MS, evictionMisses: 5,
    maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: 8,
    persistChannels: ["#dup-check", "#general"], maxChannelLogBytes: 10 * 1024 * 1024,
  } as const;
}

async function main(): Promise<void> {
  console.log("armory-mesh — Phase 4 smoke test\n");
  fs.rmSync(projectDir, { recursive: true, force: true });

  // ── 1. Channel log write-through ──────────────────────────────────────
  console.log("Criterion 1: a persisted-channel message is written to the shared ndjson log");
  const A = await createMeshCore({ config: cfg("alpha") as any, self: peer("alpha") });
  const B = await createMeshCore({ config: cfg("beta") as any, self: peer("beta") });
  await Promise.all([A.start(), B.start()]);
  await sleep(200);
  await A.send({ channel: "#dup-check", type: "finding", payload: { target: "gmtrade", severity: "HIGH", title: "reentrancy", ref: "src/x.sol" } });
  await sleep(150);
  const logFile = paths.channelLog(PROJECT, "#dup-check");
  check("channel log file exists", fs.existsSync(logFile));
  const logLines = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean) : [];
  check("log has 1 line", logLines.length === 1, `got ${logLines.length}`);
  const logged = logLines.length ? (JSON.parse(logLines[0]) as { type: string; payload: { title: string } }) : null;
  check("logged message is the finding", logged?.type === "finding" && logged?.payload.title === "reentrancy");
  const bLive = await B.get({ channel: "#dup-check" });
  check("B received the finding live", bLive.length === 1, `B got ${bLive.length}`);

  // ── 2. Late-joiner catch-up (fresh peer reads the shared log) ─────────
  console.log("Criterion 2: a fresh peer that was offline catches up from the shared log on start");
  // A sends another finding while no fresh peer is online yet (C is not started).
  await A.send({ channel: "#dup-check", type: "finding", payload: { target: "gmtrade", severity: "MED", title: "rounding", ref: "src/y.sol" } });
  await sleep(150);
  const C = await createMeshCore({ config: cfg("gamma") as any, self: peer("gamma") }); // fresh — no cursor file
  await C.start();
  await sleep(250); // catch-up runs on start
  const cCaught = await C.get({ channel: "#dup-check" });
  check("fresh peer C caught up on BOTH findings from the log", cCaught.length === 2, `C got ${cCaught.length}: ${cCaught.map((m) => (m.payload as { title: string }).title).join(",")}`);
  check("C caught f1 (reentrancy) + f2 (rounding)", cCaught.length === 2 && cCaught.some((m) => (m.payload as { title: string }).title === "reentrancy") && cCaught.some((m) => (m.payload as { title: string }).title === "rounding"));

  // 2b. No-receiver-online (the 02:00 -> 09:00 scenario)
  console.log("Criterion 2b: a finding sent with NO peer online is still persisted + caught up later");
  await B.stop(); await C.stop(); // leave A as the only live peer
  await sleep(PING_MS + 50);
  await A.send({ channel: "#dup-check", type: "finding", payload: { target: "gmtrade", severity: "INFO", title: "solo-broadcast", ref: "src/w.sol" } });
  await sleep(150);
  const E = await createMeshCore({ config: cfg("epsilon") as any, self: peer("epsilon") }); // fresh peer at "09:00"
  await E.start();
  await sleep(250);
  const eCaught = await E.get({ channel: "#dup-check" });
  check("fresh peer E caught the no-receiver broadcast from the log", eCaught.some((m) => (m.payload as { title: string }).title === "solo-broadcast"), "E got: " + eCaught.map((m) => (m.payload as { title: string }).title).join(","));
  await E.stop();

  // ── 3. Cursor resume (stable id) ──────────────────────────────────────
  console.log("Criterion 3: a peer re-joining with the same id resumes from its saved cursor");
  const stableId = "stable-cursor-id-0001";
  const D1 = await createMeshCore({ config: cfg("delta") as any, self: peer("delta", stableId) });
  await D1.start();
  await sleep(250); // D1 catches up the persisted findings via replay → cursor advances
  const d1Got = await D1.get({ channel: "#dup-check" });
  check("D1 (stable id) caught up the persisted findings from the log", d1Got.length >= 2 && d1Got.some((m) => (m.payload as { title: string }).title === "reentrancy") && d1Got.some((m) => (m.payload as { title: string }).title === "rounding"), "D1 got " + d1Got.length);
  await D1.stop(); // graceful → cursor saved
  const cursorFile = path.join(projectDir, "cursors", `${stableId}.json`);
  check("cursor file saved on graceful stop", fs.existsSync(cursorFile));
  // A sends a NEW finding after D1 stopped.
  await A.send({ channel: "#dup-check", type: "finding", payload: { target: "gmtrade", severity: "LOW", title: "gas-grief", ref: "src/z.sol" } });
  await sleep(150);
  // Re-join D with the SAME id → catch-up replays from the saved cursor → only the NEW finding.
  const D2 = await createMeshCore({ config: cfg("delta") as any, self: peer("delta", stableId) });
  await D2.start();
  await sleep(250);
  const d2Got = await D2.get({ channel: "#dup-check" });
  check("re-joined D2 resumed from cursor (only the new finding)", d2Got.length === 1 && (d2Got[0].payload as { title: string }).title === "gas-grief", `D2 got ${d2Got.length}: ${d2Got.map((m) => (m.payload as { title: string }).title).join(",")}`);

  // ── 4. fleet-state.jsonl (the durable ledger) ─────────────────────────
  console.log("Criterion 4: fleet-state.jsonl — the always-persisted durable ledger");
  await appendFleetState(PROJECT, { kind: "claim", target: "gmtrade", session: A.self.id, scope: "perps", ts: Date.now() });
  await appendFleetState(PROJECT, { kind: "finding", target: "gmtrade", session: A.self.id, severity: "HIGH", title: "reentrancy", ref: "src/x.sol", ts: Date.now() });
  const ledger = await readFleetState(PROJECT);
  check("ledger has 2 entries", ledger.length === 2, `got ${ledger.length}`);
  check("ledger entry 1 is the claim", ledger[0]?.kind === "claim" && (ledger[0] as { target: string }).target === "gmtrade");
  check("ledger entry 2 is the finding", ledger[1]?.kind === "finding");
  // mesh_fleet_state tool reads the ledger.
  setMesh(A);
  const toolRes = await meshFleetState.execute("tc", {}, undefined, undefined, {} as never);
  const parsed = JSON.parse((toolRes as { content: Array<{ text: string }> }).content[0].text) as { project: string; entries: unknown[] };
  check("mesh_fleet_state tool returns the ledger", parsed.project === PROJECT && parsed.entries.length === 2, `got ${parsed.entries.length} entries`);

  await A.stop(); await B.stop(); await C.stop(); await D2.stop();
  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log("");
  if (failures === 0) { console.log("✅ Phase 4 smoke test PASSED (all criteria)"); process.exit(0); }
  else { console.error(`❌ Phase 4 smoke test FAILED (${failures} check(s))`); process.exit(1); }
}

void main();