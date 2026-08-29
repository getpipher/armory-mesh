// armory-mesh — Phase 1 smoke test.
// Verifies the 4 done-criteria before committing Phase 1:
//   1. The extension loads + registers the 11 tools (fake-pi harness; no LLM needed).
//   2. Two mesh cores on the same project discover each other (mesh_list).
//   3. mesh_send A→B round-trips (sig + nonce verified); a tampered-signature frame is DROPPED.
//   4. A crashed peer (no graceful leave) is evicted after the liveness window (no ghost).
//
// Run: `node --import <pi-pkg>/node_modules/jiti/lib/jiti-register.mjs scripts/smoke-phase1.ts`
// (jiti resolves the .js→.ts imports the armory convention uses; plain Node can't.)

import { createMeshCore, setMesh } from "../src/mesh.js";
import { sendRawFrame } from "../src/transport.js";
import { paths, MESH_ROOT } from "../src/paths.js";
import meshExtension from "../extensions/mesh.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROJECT = "smoke-phase1";
const PING_MS = 100;
const EVICTION_MISSES = 3;
const MAX_BYTES = 256 * 1024;
const projectDir = path.join(MESH_ROOT, PROJECT);

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Criterion 1: the extension registers 11 tools ──────────────────────────
function criterion1(): void {
  console.log("Criterion 1: extension loads + registers 11 tools");
  const tools: string[] = [];
  const handlers: Record<string, unknown[]> = {};
  const fakePi: any = {
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
    },
    registerCommand() {}, // /mesh is TUI-only; the stub ignores it
    on(event: string, handler: unknown) {
      (handlers[event] ??= []).push(handler);
    },
  };
  meshExtension(fakePi);
  const expected = [
    "mesh_list", "mesh_send", "mesh_get", "mesh_await",
    "mesh_claim_target", "mesh_release_target", "mesh_bank_finding",
    "mesh_dup_check", "mesh_handoff", "mesh_fleet_state", "mesh_channels",
  ];
  check(`11 tools registered (got ${tools.length})`, tools.length === 11);
  for (const name of expected) {
    check(`tool "${name}" registered`, tools.includes(name));
  }
  check("session_start handler wired", Array.isArray(handlers.session_start) && handlers.session_start.length === 1);
  check("session_shutdown handler wired", Array.isArray(handlers.session_shutdown) && handlers.session_shutdown.length === 1);
}

// ─── Criteria 2-4: in-process two-core integration over real sockets ────────
async function criteria234(): Promise<void> {
  console.log("Criterion 2: two cores on the same project discover each other");
  // Clean slate.
  fs.rmSync(projectDir, { recursive: true, force: true });

  // Race-safe key generation: start two cores CONCURRENTLY (both hit ensureKey at once) and
  // confirm they converge on a single shared key (cross-verification must still pass).
  function peer(name: string): { id: string; name: string; model: string; host: string; socketPath: string; contextUsage?: number; lastSeen: number; alive: boolean } {
    const id = crypto.randomUUID();
    return {
      id,
      name,
      model: "test-model",
      host: os.hostname(),
      socketPath: paths.socket(PROJECT, id),
      lastSeen: Date.now(),
      alive: true,
    };
  }

  const cfg = (agentName: string) => ({
    project: PROJECT,
    agentName,
    pingMs: PING_MS,
    evictionMisses: EVICTION_MISSES,
    maxMessageBytes: MAX_BYTES,
    channelRatePerSec: 10,
    maxHops: 8,
    persistChannels: [],
  });

  const A = await createMeshCore({ config: cfg("alpha") as any, self: peer("alpha") });
  const B = await createMeshCore({ config: cfg("beta") as any, self: peer("beta") });
  await Promise.all([A.start(), B.start()]);
  setMesh(A);
  setMesh(B);

  await sleep(150); // let heartbeats + first refresh land

  const aPeers = await A.list();
  const bPeers = await B.list();
  check("A sees B", aPeers.some((p) => p.id === B.self.id), `A sees: ${aPeers.map((p) => p.name).join(",") || "nobody"}`);
  check("B sees A", bPeers.some((p) => p.id === A.self.id), `B sees: ${bPeers.map((p) => p.name).join(",") || "nobody"}`);
  check("peer carries name + model + host", aPeers.some((p) => p.id === B.self.id && p.name === "beta" && p.model === "test-model" && !!p.host));
  check("peer carries lastSeen", aPeers.some((p) => p.id === B.self.id && typeof p.lastSeen === "number"));

  // Criterion 3: signed round-trip + tampered drop.
  console.log("Criterion 3: mesh_send round-trips (sig+nonce verified); tampered frame DROPPED");
  const msgId = await A.send({ target: B.self.id, type: "text", payload: { hello: "world" } });
  check("send returned a msg id", typeof msgId === "string" && msgId.length > 0);
  await sleep(120); // delivery is async over the socket
  const got = await B.get({});
  check("B received exactly one message", got.length === 1, `got ${got.length}`);
  const m = got[0];
  check("message is from A", m?.from === A.self.id);
  check("message payload intact", (m?.payload as any)?.hello === "world");
  check("message carries a signature", typeof m?.sig === "string" && m.sig.length === 64, `sig=${m?.sig}`);
  check("message nonce is monotonic (>0)", typeof m?.nonce === "number" && m.nonce > 0);

  // Tampered-signature frame: same from (A), wrong sig → B must DROP it (auth-by-default).
  const tampered = {
    id: crypto.randomUUID(),
    from: A.self.id,
    to: B.self.id,
    channel: "#general",
    type: "text" as const,
    payload: "evil",
    nonce: 999_999,
    sig: "deadbeef".repeat(8), // 64 hex chars but wrong
    ts: Date.now(),
  };
  await sendRawFrame(B.self.socketPath, { kind: "msg", msg: tampered }, MAX_BYTES).catch((e) => void e);
  await sleep(120);
  const afterTamper = await B.get({});
  check("tampered-signature frame DROPPED", afterTamper.length === 0, `B still had ${afterTamper.length} tampered msgs`);

  // Criterion 4: crash B (no graceful leave) → A evicts after the liveness window.
  console.log(`Criterion 4: crashed peer evicted after window (${PING_MS}ms × ${EVICTION_MISSES} = ${PING_MS * EVICTION_MISSES}ms)`);
  const bFile = paths.agentFile(PROJECT, B.self.id);
  check("B's registry file exists before crash", fs.existsSync(bFile));
  await B.crash();
  // Before the window: A should still see B (grace period).
  await sleep(80);
  const beforeWindow = await A.list();
  check("A still sees B right after crash (within window)", beforeWindow.some((p) => p.id === B.self.id));
  // After the window: A's refreshPool evicts the stale entry + unlinks the file.
  await sleep(PING_MS * EVICTION_MISSES + 200);
  const afterWindow = await A.list();
  check("A no longer sees B after the eviction window (no ghost)", !afterWindow.some((p) => p.id === B.self.id), `A sees: ${afterWindow.map((p) => p.name).join(",") || "nobody"}`);
  check("B's stale registry file was cleaned up", !fs.existsSync(bFile));

  await A.stop();
  fs.rmSync(projectDir, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log("armory-mesh — Phase 1 smoke test\n");
  criterion1();
  await criteria234();
  console.log("");
  if (failures === 0) {
    console.log("✅ Phase 1 smoke test PASSED (all criteria)");
    process.exit(0);
  } else {
    console.error(`❌ Phase 1 smoke test FAILED (${failures} check(s) failed)`);
    process.exit(1);
  }
}

void main();