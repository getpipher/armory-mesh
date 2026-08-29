// armory-mesh — pi extension entry.
// Registers the mesh tools with the pi extension API. Loaded via `pi -e extensions/mesh.ts`
// or the `packages` array in `.pi/settings.json` (pi.extensions: ["./extensions"]).
//
// Phase 1: mesh_list / mesh_send / mesh_get / mesh_await (coms parity, local transport).
// The tool descriptors are defined in src/mesh.ts; the run handlers close over a module-level
// MeshCore singleton set on session_start. See DESIGN.md + ROADMAP.md.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  meshList, meshSend, meshGet, meshAwait,
  meshClaimTarget, meshReleaseTarget, meshBankFinding, meshDupCheck, meshHandoff, meshFleetState, meshChannels,
  createMeshCore, setMesh,
  type MeshCore,
} from "../src/mesh.js";
import { defaultMeshConfig, findMeshConfig, findMeshConfigPath } from "../src/config.js";
import { paths, MESH_ROOT } from "../src/paths.js";
import { runDoctor, formatDoctorReport } from "../src/doctor.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

// ─── Phase 8: project-scoped mesh config (.pi/mesh.json) ────────────────────
// findMeshConfig lives in src/config.ts (src/doctor needs it too); re-exported here so
// smoke-phase8's import path keeps working.
export { findMeshConfig, findMeshConfigPath } from "../src/config.js";

export default function meshExtension(pi: ExtensionAPI): void {
  // Phase 1: the 4 core tools (coms parity).
  pi.registerTool(meshList);
  pi.registerTool(meshSend);
  pi.registerTool(meshGet);
  pi.registerTool(meshAwait);

  // Phase 5: the fleet-state primitives.
  pi.registerTool(meshClaimTarget);
  pi.registerTool(meshReleaseTarget);
  pi.registerTool(meshBankFinding);
  pi.registerTool(meshDupCheck);
  pi.registerTool(meshHandoff);
  pi.registerTool(meshFleetState);
  pi.registerTool(meshChannels);

  // Phase 8 refine: /mesh — human surface (status + doctor). Knowledge tools stay model-driven;
  // the slash surface is for things a human wants WITHOUT a model round-trip (esp. diagnostics).
  pi.registerCommand("mesh", {
    description: "Mesh pool status (/mesh) + install/runtime diagnostics (/mesh doctor)",
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().split(/\s+/)[0];
      if (!core) {
        if (ctx.hasUI) ctx.ui.notify("mesh: not started in this session (check startup errors)", "warning");
        return;
      }
      if (sub === "doctor") {
        try {
          const cfg = core.config;
          const hubUrls = cfg.hubUrls ?? (cfg.hubUrl ? [cfg.hubUrl] : []);
          const isHub = hubUrls.length > 0 && !!cfg.authToken;
          const hubFetch = isHub
            ? async () => {
                for (const u of hubUrls) {
                  try {
                    const res = await fetch(u.replace(/\/$/, "") + "/events", {
                      headers: { "x-mesh-token": cfg.authToken ?? "" },
                      signal: AbortSignal.timeout(1500),
                    });
                    void res.body?.cancel().catch(() => {});
                    return true; // any HTTP response = the hub is reachable
                  } catch { /* try the next hub */ }
                }
                return false;
              }
            : undefined;
          const report = await runDoctor({
            cwd: ctx.cwd,
            project: cfg.project,
            selfId: core.self.id,
            selfName: cfg.agentName,
            coreStarted: true,
            mode: isHub ? "hub" : "local",
            config: cfg,
            hubUrls: isHub ? hubUrls : undefined,
            listPeers: () => core!.list(),
            meshRoot: MESH_ROOT,
            trustFile: path.join(os.homedir(), ".pi", "agent", "trust.json"),
            env: { PI_MESH_PROJECT: process.env.PI_MESH_PROJECT, PI_MESH_AGENT_NAME: process.env.PI_MESH_AGENT_NAME },
            hubFetch,
          });
          const msg = formatDoctorReport(report);
          if (ctx.hasUI) ctx.ui.notify(msg, report.checks.some((c) => c.status === "fail") ? "warning" : "info");
        } catch (e) {
          if (ctx.hasUI) ctx.ui.notify(`mesh doctor failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }
      if (!sub) {
        const peers = core.snapshotPeers();
        const lines = [
          `mesh "${core.config.project}" · ${peers.length} peer${peers.length === 1 ? "" : "s"} · ${core.config.hubUrls?.length || core.config.hubUrl ? "hub" : "local"} mode`,
          ...peers.map((p) => `  ${p.name} ${p.model} ctx:${p.contextUsage != null ? Math.round(p.contextUsage) + "%" : "--"}${p.claimedTarget ? ` ⟨${p.claimedTarget}⟩` : ""}`),
          "",
          "/mesh doctor — full install + runtime diagnostics",
        ];
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(`unknown /mesh subcommand "${sub}" — try /mesh or /mesh doctor`, "warning");
    },
  });

  let core: MeshCore | null = null;

  async function startMesh(ctx: ExtensionContext): Promise<void> {
    // Phase 8: project-scoped fleet config — nearest-ancestor .pi/mesh.json wins for project +
    // channel policy; explicit env vars still override; cwd basename is the last fallback.
    const meshFile = findMeshConfig(ctx.cwd) ?? {};
    const fileProject = typeof meshFile.project === "string" ? meshFile.project : undefined;
    const filePersist = Array.isArray(meshFile.persistChannels)
      ? (meshFile.persistChannels as unknown[]).filter((c): c is string => typeof c === "string")
      : undefined;
    const config = defaultMeshConfig({
      project: process.env.PI_MESH_PROJECT || fileProject || path.basename(ctx.cwd) || "default",
      agentName: process.env.PI_MESH_AGENT_NAME ?? `agent-${crypto.randomUUID().slice(0, 6)}`,
      // Only include the key when the file defines it — an explicit undefined in the overrides
      // spread would CLOBBER the env-derived default (caught by the Phase 2 widget smoke).
      ...(filePersist ? { persistChannels: filePersist } : {}),
    });
    const agentId = crypto.randomUUID();
    const ctxUsage = ctx.getContextUsage()?.percent;
    const self = {
      id: agentId,
      name: config.agentName,
      model: ctx.model?.id ?? "unknown",
      host: os.hostname(),
      socketPath: paths.socket(config.project, agentId),
      contextUsage: ctxUsage === null ? undefined : ctxUsage,
      lastSeen: Date.now(),
      alive: true,
    };
    core = await createMeshCore({
      config,
      self,
      getCtxUsage: () => {
        const pct = ctx.getContextUsage()?.percent;
        return pct === null ? undefined : pct;
      },
    });
    await core.start();
    setMesh(core);
    // Phase 2: the live pool widget (below the editor). Re-install on peer-set change so the TUI
    // re-renders with fresh context usage + liveness.
    core.onPeersChanged = () => installPoolWidget(ctx, core);
    installPoolWidget(ctx, core);
    try {
      ctx.ui?.notify?.(`📡 mesh: joined "${config.project}" as ${config.agentName} (${agentId.slice(0, 8)})`, "info");
    } catch {
      // best-effort
    }
  }

  async function stopMesh(): Promise<void> {
    setMesh(null);
    if (core) {
      await core.stop().catch(() => {});
      core = null;
    }
  }

  // session_start fires when the session begins (startup / resume / reload). Build + start the core
  // there so ctx (cwd, model, getContextUsage) is live.
  pi.on("session_start", async (_event, ctx) => {
    await startMesh(ctx).catch((err) => {
      try {
        ctx.ui?.notify?.(`📡 mesh: failed to start — ${err instanceof Error ? err.message : String(err)}`, "error");
      } catch {
        // best-effort
      }
    });
  });

  // Graceful shutdown: release the registry entry + close the socket (no ghost peer).
  pi.on("session_shutdown", async () => {
    await stopMesh();
  });

  // Crash/kill hardening: if the process is signaled (SIGINT/SIGTERM), try a best-effort leave so the
  // registry file doesn't ghost until the liveness eviction picks it up.
  const hardStop = () => {
    void stopMesh();
  };
  process.on("SIGINT", hardStop);
  process.on("SIGTERM", hardStop);
  process.on("beforeExit", hardStop);
}

// ─── Phase 2: the live pool widget (below the editor) ───────────────────────

/** Install/refresh the mesh-pool widget: peers + live context-window usage + claimed target +
 *  last-seen. Re-installed on each peer-set change (the heartbeat's onPeersChanged) so the TUI
 *  re-renders with fresh liveness + context usage. */
function installPoolWidget(ctx: ExtensionContext, core: MeshCore): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setWidget(
      "mesh-pool",
      (_tui, theme) => ({
        invalidate() {},
        render(width: number): string[] {
          return renderMeshPool(width, theme, core);
        },
      }),
      { placement: "belowEditor" },
    );
  } catch {
    // non-fatal (some modes have no widget surface)
  }
}

export function renderMeshPool(width: number, theme: unknown, core: MeshCore): string[] {
  const fg = (role: string, text: string): string => {
    const t = theme as { fg?: (role: string, text: string) => string } | undefined;
    return typeof t?.fg === "function" ? t.fg(role, text) : text;
  };
  void width;
  const peers = core.snapshotPeers();
  const header = `mesh ${core.config.project} · ${peers.length} peer${peers.length === 1 ? "" : "s"}`;
  if (peers.length === 0) return [fg("dim", `${header} — solo` )];
  const lines = [fg("accent", header)];
  const now = Date.now();
  for (const p of peers) {
    const ctxPct = p.contextUsage != null ? `${Math.round(p.contextUsage)}%` : "--";
    const claim = p.claimedTarget ? ` ⟨${p.claimedTarget}⟩` : "";
    const ago = Math.max(0, Math.round((now - (p.lastSeen ?? now)) / 1000));
    lines.push(fg("dim", `  ${p.name}  ${p.model}  ctx:${ctxPct}${claim}  ${ago}s`));
  }
  return lines;
}