// armory-mesh — pi extension entry.
// Registers the mesh tools with the pi extension API. Loaded via `pi -e extensions/mesh.ts`
// or the `packages` array in `.pi/settings.json` (pi.extensions: ["./extensions"]).
//
// SCAFFOLD (Phase 0) — tool descriptors defined in src/mesh.ts; the run handlers throw
// "not implemented (Phase N)" until the relevant ROADMAP phase lands. See DESIGN.md + ROADMAP.md.
//
// Phase 1 target: mesh_list / mesh_send / mesh_get / mesh_await (coms parity, local transport).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  meshList, meshSend, meshGet, meshAwait,
  meshClaimTarget, meshReleaseTarget, meshBankFinding, meshDupCheck, meshHandoff, meshFleetState, meshChannels,
} from "../src/mesh.js";

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

  // TODO(Phase 2): install the live pool widget (peers + context usage + claimed targets),
  //   refreshing on heartbeat. Model on coms's installPoolWidget (uses @earendil-works/pi-tui).
  // TODO(Phase 2): start the heartbeat loop (PI_MESH_PING_MS) + liveness eviction.
  // TODO(graceful shutdown): on session_shutdown, release claims + close the socket + deregister.
  //   (wire via pi.onShutdown / the lifecycle hooks — see coms's shutdown wiring.)
}