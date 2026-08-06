// armory-mesh — fleet-state primitives (the "rich" layer).
// SCAFFOLD (Phase 0). Phase 5: the typed, persisted fleet ops on top of the generic mesh.
// See DESIGN.md §3.6 + ROADMAP.md Phase 5.

import type { FleetState, FleetStateEntry, DupCheckResult } from "./types.js";

/**
 * The fleet-state primitives — typed, persisted ops so a fleet (bug-bounty or otherwise)
 * doesn't rebuild claim/bank/dup-check/handoff every time. All write-through to fleet-state.jsonl.
 */

/** Phase 5: atomically claim a hunt target for this session. Prevents two sessions hunting the same target. */
export async function claimTarget(target: string, scope?: string): Promise<boolean> {
  // TODO(Phase 5): broadcast a "claim" msg on #general; persist to fleet-state.jsonl; return true if won.
  //   The loser sees the winner via mesh_list (claimed-target field) + the #general claim broadcast.
  void target; void scope;
  throw new Error("claimTarget: not implemented (Phase 5)");
}

/** Phase 5: release a claim (on exit or handoff). */
export async function releaseTarget(target: string): Promise<void> {
  void target;
  throw new Error("releaseTarget: not implemented (Phase 5)");
}

/** Phase 5: announce + persist a banked finding on #dup-check. */
export async function bankFinding(target: string, severity: string, title: string, ref: string): Promise<void> {
  void target; void severity; void title; void ref;
  throw new Error("bankFinding: not implemented (Phase 5)");
}

/**
 * Phase 5: cross-hunt dup-check — broadcast a "dup_check" request on #dup-check + await the peers'
 * "dup_check_result" responses. The killer feature for parallel bug-bounty (live cross-hunt dup-check).
 */
export async function dupCheck(target: string, title: string, rootCause: string, timeoutMs = 5000): Promise<DupCheckResult[]> {
  // TODO(Phase 5): mesh_send(channel="#dup-check", type="dup_check", payload={target, title, rootCause})
  //   + mesh_await(type="dup_check_result", timeoutMs) -> collect.
  void target; void title; void rootCause; void timeoutMs;
  throw new Error("dupCheck: not implemented (Phase 5)");
}

/** Phase 5: announce a session-handoff pointer on #handoff (persists so the next session + peers know). */
export async function handoff(target: string, handoffPath: string): Promise<void> {
  void target; void handoffPath;
  throw new Error("handoff: not implemented (Phase 5)");
}

/** Phase 5: read the durable fleet-state ledger (all claims, findings, handoffs, dup-checks). */
export async function fleetState(): Promise<FleetState> {
  throw new Error("fleetState: not implemented (Phase 5)");
}

/** Phase 5: append a fleet-state entry (the write-through to fleet-state.jsonl). */
export async function appendFleetEntry(entry: FleetStateEntry): Promise<void> {
  void entry;
  throw new Error("appendFleetEntry: not implemented (Phase 5)");
}