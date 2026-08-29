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
import { defaultMeshConfig } from "../src/config.js";
import { paths } from "../src/paths.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

// ─── Phase 8: project-scoped mesh config (.pi/mesh.json) ────────────────────
/**
 * Find the nearest-ancestor `.pi/mesh.json` from `dir` (inclusive). Project-scoped fleet config:
 * a workspace root (e.g. a bug-bounty bucket) drops one file and EVERY session fired in any child
 * folder joins the same mesh pool — cross-hunt dup-check with zero env vars. Precedence for the
 * project id: PI_MESH_PROJECT env > mesh.json.project > cwd basename.
 */
export function findMeshConfig(dir: string): Record<string, unknown> | null {
  let cur = dir;
  for (;;) {
    const p = path.join(cur, ".pi", "mesh.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // no mesh.json at this level — keep walking up
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

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