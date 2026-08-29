// armory-mesh — /mesh doctor smoke: the diagnostics engine (runDoctor) against fabricated state.
//   1. Healthy local setup → all checks ok (key 0600, fresh self registration, live socket, ledger).
//   2. Missing key → fail with a fix hint. Undersized key → fail.
//   3. World-writable key → warn (perms).
//   4. Stale self registration (lastSeen older than the eviction window) → warn.
//   5. Claims dir: live holder → ok; dead holder → "reclaimable" (informative).
//   6. Hub mode with an unreachable hubUrl → fail; reachable hub → ok (local http server).
//   7. cwd package wiring: .pi/settings.json containing armory-mesh → ok; missing file → warn; user-scope → warn.
//   8. Trust: cwd in trust.json (true) → ok; absent → warn.
// Run: `pnpm test:smoke-doctor` (jiti).

import { runDoctor, type DoctorDeps } from "../src/doctor.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const statusOf = (r: { checks: Array<{ id: string; status: string }> }, id: string) =>
  r.checks.find((c) => c.id === id)?.status;

function mkMeshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-doctor-"));
  const proj = path.join(root, "testproj");
  fs.mkdirSync(path.join(proj, "agents"), { recursive: true });
  fs.mkdirSync(path.join(proj, "sockets"), { recursive: true });
  fs.mkdirSync(path.join(proj, "claims"), { recursive: true });
  fs.mkdirSync(path.join(proj, "logs"), { recursive: true });
  fs.writeFileSync(path.join(proj, "key"), Buffer.alloc(32, 7), { mode: 0o600 });
  return root;
}
function writeCwdSettings(cwd: string, entry: string | null): void {
  fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  const pkgs = entry ? [entry] : [];
  fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: pkgs }));
}
function writeTrust(home: string, entries: Record<string, boolean>): void {
  fs.writeFileSync(path.join(home, "trust.json"), JSON.stringify(entries));
}
// trust.json lives at ~/.pi/agent/trust.json in production; the smoke writes it at <home>/trust.json
// and passes that exact path as deps.trustFile.

function baseDeps(meshRoot: string, cwd: string, home: string, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    cwd,
    project: "testproj",
    selfId: "self-1",
    selfName: "self",
    coreStarted: true,
    mode: "local",
    config: { pingMs: 100, evictionMisses: 3, maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: 8, persistChannels: ["#dup-check"] } as DoctorDeps["config"],
    listPeers: async () => [],
    meshRoot,
    trustFile: path.join(home, "trust.json"),
    env: {},
    now: Date.now(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  console.log("armory-mesh — /mesh doctor smoke test\n");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-doctor-home-"));

  // ── 1. Healthy local setup ────────────────────────────────────────────
  const root1 = mkMeshRoot();
  const cwd1 = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-doctor-cwd-"));
  writeCwdSettings(cwd1, "~/local-dev/getpipher/armory-mesh");
  writeTrust(home, { [cwd1]: true });
  const proj1 = path.join(root1, "testproj");
  const now = Date.now();
  fs.writeFileSync(path.join(proj1, "agents", "self-1.json"), JSON.stringify({ id: "self-1", lastSeen: now - 50, alive: true }));
  fs.writeFileSync(path.join(proj1, "sockets", "self-1.sock"), "");
  fs.writeFileSync(path.join(proj1, "fleet-state.jsonl"), JSON.stringify({ kind: "claim", target: "t", session: "s", ts: now }) + "\n");
  fs.writeFileSync(path.join(proj1, "logs", "%23dup-check.ndjson"), '{"id":"m1"}\n');
  const r1 = await runDoctor(baseDeps(root1, cwd1, home));
  check("healthy setup: key ok", statusOf(r1, "key") === "ok");
  check("healthy setup: self registration ok", statusOf(r1, "self") === "ok");
  check("healthy setup: socket ok", statusOf(r1, "socket") === "ok");
  check("healthy setup: cwd wiring ok", statusOf(r1, "wiring") === "ok");
  check("healthy setup: trust ok", statusOf(r1, "trust") === "ok");
  check("healthy setup: ledger informative (no fail)", statusOf(r1, "ledger") !== "fail");
  check("healthy setup: join source is cwd-basename", r1.joinedVia.includes("cwd"));

  // ── 2. Missing / undersized key ───────────────────────────────────────
  const root2 = mkMeshRoot();
  fs.unlinkSync(path.join(root2, "testproj", "key"));
  const r2 = await runDoctor(baseDeps(root2, cwd1, home, { selfId: "self-2" }));
  check("missing key → fail with hint", statusOf(r2, "key") === "fail" && /first join|created/.test(r2.checks.find((c) => c.id === "key")?.hint ?? ""));
  fs.writeFileSync(path.join(root2, "testproj", "key"), Buffer.alloc(8, 1), { mode: 0o600 });
  const r2b = await runDoctor(baseDeps(root2, cwd1, home, { selfId: "self-2" }));
  check("undersized key (<16 bytes) → fail", statusOf(r2b, "key") === "fail");

  // ── 3. Loose key perms → warn ─────────────────────────────────────────
  const root3 = mkMeshRoot();
  fs.chmodSync(path.join(root3, "testproj", "key"), 0o644);
  const r3 = await runDoctor(baseDeps(root3, cwd1, home, { selfId: "self-3" }));
  check("world-readable key → warn", statusOf(r3, "key") === "warn");

  // ── 4. Stale self registration → warn ─────────────────────────────────
  const root4 = mkMeshRoot();
  const proj4 = path.join(root4, "testproj");
  fs.writeFileSync(path.join(proj4, "agents", "self-1.json"), JSON.stringify({ id: "self-1", lastSeen: now - 10_000, alive: true }));
  const r4 = await runDoctor(baseDeps(root4, cwd1, home));
  check("stale self lastSeen → warn", statusOf(r4, "self") === "warn");

  // ── 5. Claims: live holder vs dead holder ─────────────────────────────
  const root5 = mkMeshRoot();
  const proj5 = path.join(root5, "testproj");
  fs.writeFileSync(path.join(proj5, "agents", "self-1.json"), JSON.stringify({ id: "self-1", lastSeen: now - 50, alive: true }));
  fs.writeFileSync(path.join(proj5, "claims", "live-target.json"), JSON.stringify({ session: "self-1", target: "live-target", ts: now }));
  fs.writeFileSync(path.join(proj5, "claims", "dead-target.json"), JSON.stringify({ session: "ghost-session", target: "dead-target", ts: now }));
  const r5 = await runDoctor(baseDeps(root5, cwd1, home));
  check("live claim holder → ok", statusOf(r5, "claims") === "ok");
  const deadCheck = r5.checks.find((c) => c.id === "claims");
  check("dead claim holder reported reclaimable", /1.*reclaimable|reclaimable.*1/i.test(deadCheck?.detail ?? ""));

  // ── 6. Hub mode: reachable vs unreachable ─────────────────────────────
  const hubSrv = http.createServer((_req, res) => { res.writeHead(401); res.end("{}"); });
  await new Promise<void>((r) => hubSrv.listen(0, "127.0.0.1", r));
  const hubPort = (hubSrv.address() as { port: number }).port;
  const r6ok = await runDoctor(baseDeps(root5, cwd1, home, {
    mode: "hub", hubUrls: [`http://127.0.0.1:${hubPort}`], hubFetch: async () => true,
  }));
  check("hub mode + reachable hub → ok", statusOf(r6ok, "hub") === "ok");
  const r6bad = await runDoctor(baseDeps(root5, cwd1, home, {
    mode: "hub", hubUrls: ["http://127.0.0.1:1"], hubFetch: async () => false,
  }));
  check("hub mode + unreachable hub → fail", statusOf(r6bad, "hub") === "fail");
  hubSrv.close();

  // ── 7. cwd wiring variants ────────────────────────────────────────────
  const cwd7 = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-doctor-cwd7-"));
  const r7none = await runDoctor(baseDeps(root1, cwd7, home));
  check("no cwd .pi/settings.json → warn (loaded via -e or user scope)", statusOf(r7none, "wiring") === "warn");
  writeCwdSettings(cwd7, "@getpipher/other-pkg");
  const r7other = await runDoctor(baseDeps(root1, cwd7, home));
  check("cwd settings without armory-mesh → warn", statusOf(r7other, "wiring") === "warn");

  // ── 8. Trust variants ─────────────────────────────────────────────────
  const home8 = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-doctor-home8-"));
  writeTrust(home8, { [path.join(cwd1, "child")]: false });
  const cwd8 = path.join(cwd1, "child");
  fs.mkdirSync(cwd8, { recursive: true });
  const r8false = await runDoctor(baseDeps(root1, cwd8, home8));
  check("explicit trust=false on cwd → fail", statusOf(r8false, "trust") === "fail");
  const r8absent = await runDoctorSync8(baseDeps(root1, cwd1, home8));
  check("no trust decision anywhere → warn", statusOf(r8absent, "trust") === "warn");

  // ── 9. env override reflected in joinedVia ────────────────────────────
  const r9 = await runDoctor(baseDeps(root1, cwd1, home, { env: { PI_MESH_PROJECT: "envproj" }, project: "envproj" }));
  check("env override reported as the join source", r9.joinedVia.includes("env"));

  // cleanup
  fs.rmSync(home, { recursive: true, force: true });
  for (const d of [cwd1, cwd7, cwd8]) fs.rmSync(d, { recursive: true, force: true });
  for (const r of [root1, root2, root3, root4, root5]) fs.rmSync(r, { recursive: true, force: true });

  console.log("");
  if (failures === 0) { console.log("✅ /mesh doctor smoke PASSED (all criteria)"); process.exit(0); }
  else { console.error(`❌ /mesh doctor smoke FAILED (${failures} check(s))`); process.exit(1); }
}

// trust check is sync-friendly in runDoctor? No — runDoctor is async; small helper for the sync call site.
function runDoctorSync8(deps: DoctorDeps): Promise<Awaited<ReturnType<typeof runDoctor>>> {
  return runDoctor(deps);
}

void main();