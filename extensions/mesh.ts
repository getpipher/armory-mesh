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
import crypto from "node:crypto";

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
    const config = defaultMeshConfig({
      project: process.env.PI_MESH_PROJECT || path.basename(ctx.cwd) || "default",
      agentName: process.env.PI_MESH_AGENT_NAME ?? `agent-${crypto.randomUUID().slice(0, 6)}`,
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
    core = await createMeshCore({ config, self });
    await core.start();
    setMesh(core);
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

  // TODO(Phase 2): install the live pool widget (peers + context usage + claimed targets),
  //   refreshing on heartbeat. Model on coms's installPoolWidget (uses @earendil-works/pi-tui).
  // TODO(Phase 2): start the heartbeat loop (PI_MESH_PING_MS) + liveness eviction (socket-level ping).
}