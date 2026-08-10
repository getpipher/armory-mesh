// armory-mesh — Phase 3 smoke: typed messages + channels.
//   1. Default channel (#general) broadcast reaches all peers.
//   2. Per-target channel (#gmtrade) routes ONLY to subscribers (a non-subscriber doesn't receive).
//   3. Typed payload validation: valid finding accepted; invalid finding rejected; text free-form.
//   4. mesh_channels lists channels + live subscriber counts.
//   5. mesh_get / mesh_await filter by channel + type.
// Run: `pnpm test:smoke3` (jiti).

import { createMeshCore } from "../src/mesh.js";
import { paths, MESH_ROOT } from "../src/paths.js";
import { validateType } from "../src/channels.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT = "smoke-phase3";
const PING_MS = 100;
const EVICTION_MISSES = 5;
const MAX_BYTES = 256 * 1024;
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
  return { project: PROJECT, agentName: n, pingMs: PING_MS, evictionMisses: EVICTION_MISSES, maxMessageBytes: MAX_BYTES, channelRatePerSec: 10, maxHops: 8, persistChannels: [] } as const;
}

async function main(): Promise<void> {
  console.log("armory-mesh — Phase 3 smoke test\n");
  fs.rmSync(projectDir, { recursive: true, force: true });

  const A = await createMeshCore({ config: cfg("alpha") as any, self: peer("alpha"), getCtxUsage: () => 10 });
  const B = await createMeshCore({ config: cfg("beta") as any, self: peer("beta"), getCtxUsage: () => 20 });
  const C = await createMeshCore({ config: cfg("gamma") as any, self: peer("gamma"), getCtxUsage: () => 30 });
  await Promise.all([A.start(), B.start(), C.start()]);
  await sleep(350); // let heartbeats + default subscriptions propagate

  // ── 1. Default channel broadcast ──────────────────────────────────────
  console.log("Criterion 1: default channel (#general) broadcast reaches all peers");
  await A.send({ channel: "#general", type: "text", payload: "hello-fleet" });
  await sleep(120);
  const bGeneral = await B.get({ channel: "#general" });
  const cGeneral = await C.get({ channel: "#general" });
  check("B received the #general broadcast", bGeneral.length === 1 && (bGeneral[0].payload as string) === "hello-fleet", `B got ${bGeneral.length}`);
  check("C received the #general broadcast", cGeneral.length === 1, `C got ${cGeneral.length}`);

  // ── 2. Per-target channel routing (subscribers only) ──────────────────
  console.log("Criterion 2: per-target channel (#gmtrade) routes only to subscribers");
  A.subscribe("#gmtrade");
  B.subscribe("#gmtrade");
  // C stays unsubscribed from #gmtrade. Wait for the subscription gossip (heartbeats carry channels).
  await sleep(PING_MS * 3 + 120);
  check("A knows B subscribed to #gmtrade", (A.snapshotPeers().find((p) => p.id === B.self.id)?.channels ?? []).includes("#gmtrade"));
  check("A knows C NOT subscribed to #gmtrade", !(A.snapshotPeers().find((p) => p.id === C.self.id)?.channels ?? []).includes("#gmtrade"));
  await A.send({ channel: "#gmtrade", type: "text", payload: "gm-only" });
  await sleep(120);
  const bGm = await B.get({ channel: "#gmtrade" });
  const cAny = await C.get({});
  check("B (subscriber) received the #gmtrade message", bGm.length === 1 && (bGm[0].payload as string) === "gm-only", `B got ${bGm.length}`);
  check("C (non-subscriber) did NOT receive the #gmtrade message", cAny.length === 0, `C got ${cAny.length}: ${JSON.stringify(cAny)}`);

  // ── 3. Typed payload validation ───────────────────────────────────────
  console.log("Criterion 3: typed payload validation (mesh_send rejects malformed payloads)");
  check("validateType: valid finding passes", validateType("finding", { target: "t", severity: "H", title: "x", ref: "r" }).length === 0);
  check("validateType: finding missing fields fails", validateType("finding", { target: "t" }).length === 3);
  check("validateType: text is free-form (always valid)", validateType("text", "anything").length === 0);
  check("validateType: dup_check_result requires overlap boolean", validateType("dup_check_result", { overlap: "yes" }).length === 1);
  // mesh_send rejects an invalid finding (throws before sending).
  let threw = false;
  try { await A.send({ channel: "#general", type: "finding", payload: { target: "t" } }); } catch { threw = true; }
  check("mesh_send throws on an invalid finding payload", threw);
  // mesh_send accepts a valid finding.
  let findingId = "";
  try { findingId = await A.send({ channel: "#general", type: "finding", payload: { target: "gmtrade", severity: "HIGH", title: "reentrancy", ref: "src/x.sol" } }); } catch (e) { check("mesh_send accepts a valid finding", false, String(e)); }
  check("mesh_send accepted the valid finding (returned an id)", typeof findingId === "string" && findingId.length > 0);
  await sleep(120);
  const bFinding = await B.get({ type: "finding" });
  check("B received the valid finding (filtered by type)", bFinding.length === 1 && (bFinding[0].payload as { severity: string }).severity === "HIGH", `B got ${bFinding.length}`);

  // ── 4. mesh_channels ──────────────────────────────────────────────────
  console.log("Criterion 4: mesh_channels lists channels + subscriber counts");
  const channels = A.channelsView();
  const gm = channels.find((c) => c.name === "#gmtrade");
  const general = channels.find((c) => c.name === "#general");
  check("#gmtrade listed with 2 subscribers (A+B)", gm?.subscribers === 2, `got ${gm?.subscribers}`);
  check("#general listed with 3 subscribers (A+B+C)", general?.subscribers === 3, `got ${general?.subscribers}`);
  check("all 5 default channels present", ["#general", "#dup-check", "#learnings", "#handoff", "#heartbeats"].every((c) => channels.some((ch) => ch.name === c)));

  // ── 5. mesh_await filter by channel + type ────────────────────────────
  console.log("Criterion 5: mesh_await blocks for a matching typed message");
  // B awaits a dup_check_result from A; A sends one on #dup-check.
  const awaitP = B.awaitMsg({ type: "dup_check_result", timeoutMs: 1500 });
  await sleep(150); // let B start awaiting
  await A.send({ target: B.self.id, type: "dup_check_result", payload: { overlap: false, note: "no match" } });
  const awaited = await awaitP;
  check("mesh_await returned the matching dup_check_result", !!awaited && (awaited.payload as { overlap: boolean }).overlap === false, `got ${JSON.stringify(awaited)}`);

  await A.stop(); await B.stop(); await C.stop();
  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log("");
  if (failures === 0) { console.log("✅ Phase 3 smoke test PASSED (all criteria)"); process.exit(0); }
  else { console.error(`❌ Phase 3 smoke test FAILED (${failures} check(s))`); process.exit(1); }
}

void main();