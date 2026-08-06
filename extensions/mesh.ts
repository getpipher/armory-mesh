// armory-mesh — pi extension entry.
// Registers the mesh tools with the pi tool registry. Loaded via `pi -e extensions/mesh.ts`
// or the `packages` array in `.pi/settings.json` (pi.extensions: ["./extensions"]).
//
// SCAFFOLD (Phase 0) — tool signatures defined; implementation in src/mesh.ts (Phase 1+).
// See DESIGN.md (the architecture) + ROADMAP.md (the build phases).
//
// Phase 1 target: mesh_list / mesh_send / mesh_get / mesh_await (coms parity, local transport).

import type { PiExtensionContext } from "@earendil-works/pi-coding-agent";
import { meshList, meshSend, meshGet, meshAwait, meshClaimTarget, meshReleaseTarget, meshBankFinding, meshDupCheck, meshHandoff, meshFleetState, meshChannels } from "../src/mesh.js";

export default function meshExtension(ctx: PiExtensionContext): void {
  // TODO(Phase 1): wire the transport + registry + auth on extension load (see src/mesh.ts).
  // ctx provides the pi lifecycle hooks (session_start, turn_start, tool_call, ...) —
  // emit ObsEvents compatible with disler/pi-agent-observability for mesh traffic (Phase 7).

  ctx.tools.register(meshList);
  ctx.tools.register(meshSend);
  ctx.tools.register(meshGet);
  ctx.tools.register(meshAwait);

  // TODO(Phase 5): register the fleet-state primitives.
  ctx.tools.register(meshClaimTarget);
  ctx.tools.register(meshReleaseTarget);
  ctx.tools.register(meshBankFinding);
  ctx.tools.register(meshDupCheck);
  ctx.tools.register(meshHandoff);
  ctx.tools.register(meshFleetState);
  ctx.tools.register(meshChannels);

  // TODO(Phase 2): install the live pool widget (peers + context usage + claimed targets),
  //   refreshing on heartbeat. Model on coms's installPoolWidget.
  // TODO(Phase 2): start the heartbeat loop (PI_MESH_PING_MS) + liveness eviction.
  // TODO(graceful shutdown): on session_shutdown, release claims + close the socket + deregister.
}