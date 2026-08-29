// armory-mesh — Phase 2 widget smoke: exercises the extension's real session_start →
// installPoolWidget → setWidget(factory) → render(width) path with a stubbed ctx.ui + a real
// MeshCore + a live seed peer. Confirms the widget install + render path throws nothing and
// surfaces the live peer (name + context usage). (A real nested pi TUI can't be driven from
// inside a pi session — pi exits on the alt screen — so this is the faithful substitute.)

import meshExtension, { renderMeshPool } from "../extensions/mesh.js";
import { createMeshCore } from "../src/mesh.js";
import { paths, MESH_ROOT } from "../src/paths.js";
import os from "node:os";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROJECT = "smoke-widget";
const PING_MS = 100;
const projectDir = path.join(MESH_ROOT, PROJECT);

let failures = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log(`  ✓ ${label}`);
  else { failures++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("armory-mesh — Phase 2 widget smoke\n");
  fs.rmSync(projectDir, { recursive: true, force: true });
  // The extension derives the project from PI_MESH_PROJECT || basename(cwd); force it to ours.
  // Fast liveness so the eviction check resolves quickly.
  process.env.PI_MESH_PROJECT = PROJECT;
  process.env.PI_MESH_PING_MS = "100";
  process.env.PI_MESH_EVICTION_MISSES = "3";

  // 1. A live seed peer (beta) in the same project, so the widget has a peer to render.
  const betaId = crypto.randomUUID();
  const betaSelf = { id: betaId, name: "beta", model: "glm-5.2:cloud", host: os.hostname(), socketPath: paths.socket(PROJECT, betaId), contextUsage: 33, lastSeen: Date.now(), alive: true };
  const beta = await createMeshCore({
    config: { project: PROJECT, agentName: "beta", pingMs: PING_MS, evictionMisses: 5, maxMessageBytes: 256 * 1024, channelRatePerSec: 10, maxHops: 8, persistChannels: [] } as any,
    self: betaSelf,
    getCtxUsage: () => 33,
  });
  await beta.start();

  // 2. Load the extension with a fake pi + fake ctx, and fire its session_start handler.
  let captured: { render: (w: number) => string[] } | null = null;
  let setWidgetCalls = 0;
  const fakePi: any = {
    registerTool() {},
    registerCommand() {}, // /mesh is TUI-only; the stub ignores it
    on(_event: string, handler: (e: unknown, ctx: unknown) => Promise<void>) {
      (fakePi._handlers ??= {})[_event] = handler;
    },
  };
  meshExtension(fakePi);

  const fakeCtx: any = {
    cwd: process.cwd(),
    model: { id: "alpha-model" },
    hasUI: true,
    getContextUsage: () => ({ percent: 50, tokens: 1000, contextWindow: 2000 }),
    ui: {
      notify() {},
      setWidget(_key: string, content: unknown, _opts: unknown) {
        setWidgetCalls++;
        if (typeof content === "function") {
          const comp = (content as (t: unknown, th: unknown) => { render: (w: number) => string[] })({}, { fg: (_r: string, t: string) => t });
          captured = comp as { render: (w: number) => string[] };
        }
      },
    },
  };

  // Fire session_start (the extension's startMesh → createMeshCore → core.start → installPoolWidget).
  await fakePi._handlers.session_start({ type: "session_start", reason: "startup" }, fakeCtx);

  // 3. Wait for heartbeats to populate alpha's live view of beta, then render the widget.
  await sleep(PING_MS * 3 + 120);
  if (!captured) { check("setWidget factory captured", false, "session_start did not install the widget"); }
  const lines = captured ? captured.render(80) : [];

  check("session_start installed the pool widget (setWidget called)", setWidgetCalls > 0);
  check("render returned lines without throwing", Array.isArray(lines) && lines.length > 0, `lines=${JSON.stringify(lines)}`);
  check("widget header names the project", lines.some((l) => l.includes(`mesh ${PROJECT}`)));
  check("widget shows the live peer 'beta'", lines.some((l) => l.includes("beta")), `lines=${JSON.stringify(lines)}`);
  check("widget shows beta's context usage (33%)", lines.some((l) => l.includes("ctx:33%")), `lines=${JSON.stringify(lines)}`);

  // 4. Direct renderMeshPool call against the alpha core (the in-session core set by startMesh).
  //    (The module singleton is set by the extension; reach it via the captured snapshot path.)
  //    Re-render after the seed peer leaves → "solo".
  await beta.stop();
  await sleep(PING_MS * 5 + 300); // gossip eviction window (alpha: 100ms × 3 = 300ms) + buffer
  const soloLines = captured ? captured.render(80) : [];
  check("widget renders 'solo' after the peer evicts", soloLines.some((l) => l.includes("solo")), `lines=${JSON.stringify(soloLines)}`);

  // Best-effort: also call renderMeshPool directly with a stub core to prove it handles 0 peers.
  const stubCore: any = { config: { project: "stub" }, snapshotPeers: () => [] };
  const stubLines = renderMeshPool(80, { fg: (_r: string, t: string) => t }, stubCore);
  check("renderMeshPool handles an empty pool (no throw)", Array.isArray(stubLines) && stubLines.some((l) => l.includes("solo")));

  // ── Compact mode: cap rows + "+K more", most-recently-seen first ──
  const mkPeers = (n: number): any[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, name: `peer-${String(i).padStart(2, "0")}`, model: "m", host: "h",
      lastSeen: Date.now() - (n - i) * 1000, alive: true, // peer-14 most recent, peer-00 least
    }));
  const themeStub = { fg: (_r: string, t: string) => t };

  // 15 peers, default cap (10): header + 10 rows + 1 overflow line.
  const capped = renderMeshPool(80, themeStub, { config: { project: "cap" }, snapshotPeers: () => mkPeers(15) } as any);
  check("compact: 15 peers → 12 lines (header + 10 rows + +K more)", capped.length === 12, `got ${capped.length}`);
  check("compact: overflow line says '+5 more peers'", capped.some((l) => l.includes("+5 more peers")), JSON.stringify(capped));
  const mostRecent = mkPeers(15)[14].name; // newest lastSeen
  const oldest = mkPeers(15)[0].name;
  check("compact: most-recent peer is shown", capped.some((l) => l.includes(mostRecent)));
  check("compact: stale peer collapses into the overflow", !capped.some((l) => l.includes(oldest)));

  // Exactly at cap: no overflow line.
  const atCap = renderMeshPool(80, themeStub, { config: { project: "cap" }, snapshotPeers: () => mkPeers(10) } as any);
  check("compact: exactly-at-cap shows all rows, no overflow line", atCap.length === 11 && !atCap.some((l) => l.includes("more peers")), `got ${atCap.length}`);

  // Explicit widgetMaxRows=3 overrides the default.
  const tiny = renderMeshPool(80, themeStub, { config: { project: "cap", widgetMaxRows: 3 }, snapshotPeers: () => mkPeers(15) } as any);
  check("compact: widgetMaxRows=3 → 5 lines (header + 3 + +12 more)", tiny.length === 5 && tiny.some((l) => l.includes("+12 more peers")), `got ${tiny.length}`);

  // The env knob feeds defaultMeshConfig → config.widgetMaxRows.
  process.env.PI_MESH_WIDGET_MAX_ROWS = "4";
  const { defaultMeshConfig } = await import("../src/config.js");
  const envCfg = defaultMeshConfig();
  check("compact: PI_MESH_WIDGET_MAX_ROWS=4 lands in config", envCfg.widgetMaxRows === 4, `got ${envCfg.widgetMaxRows}`);
  delete process.env.PI_MESH_WIDGET_MAX_ROWS;

  fs.rmSync(projectDir, { recursive: true, force: true });
  console.log("");
  if (failures === 0) { console.log("✅ Phase 2 widget smoke PASSED"); process.exit(0); }
  else { console.error(`❌ Phase 2 widget smoke FAILED (${failures} check(s))`); process.exit(1); }
}

void main();