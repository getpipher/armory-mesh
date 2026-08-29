// armory-mesh — fleet-state primitives (the "rich" layer).
// See DESIGN.md §3.6 + ROADMAP.md Phase 5.
//
// Typed, persisted ops on top of the generic mesh so a fleet (bug-bounty or otherwise) doesn't
// rebuild claim/bank/dup-check/handoff every time. All write-through to fleet-state.jsonl.
//
// These close over a session's internals, so they're a factory `createFleetStatePrimitives(ctx)`
// the MeshCore wires in. The ctx carries the deps (config, self-ref mutators, send, transport,
// auth.sign, nextNonce, registry, inbound queue) — kept as a narrow interface so this module
// stays testable in isolation.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { paths } from "./paths.js";
import { appendFleetState, readFleetState } from "./persistence.js";
import type { Peer, MeshMsg, MsgType, DupCheckResult, FleetStateEntry } from "./index.js";

export interface FleetStateCtx {
  project: string;
  selfId: string;
  pingMs: number;
  evictionMisses: number;
  /** Set self's claimed-target (mutates the live Peer + persists via the registry). */
  setClaimedTarget(target: string | undefined): void;
  /** Sign a message body (auth.sign). */
  sign(msg: Omit<MeshMsg, "sig">): string;
  /** Next per-sender monotonic nonce. */
  nextNonce(): number;
  /** Send a typed message to a peer or channel (the mesh's send). */
  send(args: { target?: string; channel?: string; type: MsgType; payload: unknown }): Promise<string>;
  /** Low-level transport send to one peer (for the dup_check_result reply). */
  transportSend(to: string, frame: { kind: "msg"; msg: MeshMsg }): Promise<void>;
  /** The inbound queue (for collecting dup_check_result responses). */
  inbound: MeshMsg[];
}

export interface FleetStatePrimitives {
  claimTarget(target: string, scope?: string): Promise<boolean>;
  releaseTarget(target: string): Promise<void>;
  bankFinding(target: string, severity: string, title: string, ref: string): Promise<void>;
  dupCheck(target: string, title: string, rootCause: string, timeoutMs?: number): Promise<DupCheckResult[]>;
  handoff(target: string, handoffPath: string): Promise<void>;
  /** Auto-respond to an inbound dup_check request (called by handleFrame). */
  respondToDupCheck(reqMsg: MeshMsg): Promise<void>;
}

async function readClaim(file: string): Promise<{ session: string; target: string; scope?: string; ts: number } | undefined> {
  try { return JSON.parse(await fs.readFile(file, "utf-8")) as { session: string; target: string; scope?: string; ts: number }; } catch { return undefined; }
}

async function isPeerAlive(ctx: FleetStateCtx, agentId: string): Promise<boolean> {
  try {
    const p = JSON.parse(await fs.readFile(paths.agentFile(ctx.project, agentId), "utf-8")) as Peer;
    return Date.now() - (p.lastSeen ?? 0) <= ctx.pingMs * ctx.evictionMisses;
  } catch { return false; }
}

/** Check the local fleet-state ledger for a finding overlapping the candidate. */
async function hasOverlappingFinding(project: string, target: string | undefined, title: string | undefined, rootCause: string | undefined): Promise<{ overlap: boolean; note?: string }> {
  const ledger = await readFleetState(project);
  for (const e of ledger) {
    if (e.kind !== "finding") continue;
    if (target && e.target !== target) continue;
    if (title && e.title === title) return { overlap: true, note: `match: ${e.title} (${e.severity})` };
    if (rootCause && (e.title.includes(rootCause) || e.ref.includes(rootCause))) return { overlap: true, note: `root-cause match: ${e.title}` };
  }
  return { overlap: false };
}

/**
 * Phase 7: materialize a RECEIVED finding into the local ledger (the cross-machine fleet-state
 * fix). A finding banked by a peer on machine Y arrives here as a channel message (live or hub
 * replay); materializing it makes the LOCAL `mesh_dup_check` overlap check see it — otherwise the
 * ledger would only know about this machine's own findings. Dedup by (target, title, session) so
 * replays + repeated broadcasts don't grow the ledger unbounded. Returns true if appended.
 */
export async function materializeReceivedFinding(
  project: string,
  from: string,
  payload: { target?: unknown; severity?: unknown; title?: unknown; ref?: unknown },
): Promise<boolean> {
  const target = typeof payload.target === "string" ? payload.target : undefined;
  const title = typeof payload.title === "string" ? payload.title : undefined;
  if (!target || !title) return false;
  const severity = typeof payload.severity === "string" ? payload.severity : "unknown";
  const ref = typeof payload.ref === "string" ? payload.ref : "";
  const ledger = await readFleetState(project);
  const dup = ledger.some((e) => e.kind === "finding" && e.target === target && e.title === title && e.session === from);
  if (dup) return false;
  const entry: FleetStateEntry = { kind: "finding", target, session: from, severity, title, ref, ts: Date.now() };
  await appendFleetState(project, entry).catch(() => {});
  return true;
}

function buildSignedMsg(ctx: FleetStateCtx, to: string, type: MsgType, channel: string, payload: unknown): MeshMsg {
  const msg: MeshMsg = { id: crypto.randomUUID(), from: ctx.selfId, to, channel, type, payload, nonce: ctx.nextNonce(), sig: "", ts: Date.now() };
  msg.sig = ctx.sign(msg);
  return msg;
}

export function createFleetStatePrimitives(ctx: FleetStateCtx): FleetStatePrimitives {
  async function claimTarget(target: string, scope?: string): Promise<boolean> {
    const file = paths.claimFile(ctx.project, target);
    await fs.mkdir(paths.claimsDir(ctx.project), { recursive: true }).catch(() => {});
    const claim = { session: ctx.selfId, target, scope, ts: Date.now() };
    let won = false;
    try {
      const fh = await fs.open(file, "wx", 0o600);
      await fh.writeFile(JSON.stringify(claim));
      await fh.close();
      won = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const existing = await readClaim(file);
      won = !!(existing && !(await isPeerAlive(ctx, existing.session)));
      if (won) await fs.writeFile(file, JSON.stringify(claim), { mode: 0o600 });
    }
    if (won) {
      ctx.setClaimedTarget(target);
      const entry: FleetStateEntry = { kind: "claim", target, session: ctx.selfId, scope, ts: Date.now() };
      await appendFleetState(ctx.project, entry).catch(() => {});
      await ctx.send({ channel: "#general", type: "claim", payload: { target, scope } }).catch(() => {});
    }
    return won;
  }

  async function releaseTarget(target: string): Promise<void> {
    const file = paths.claimFile(ctx.project, target);
    const existing = await readClaim(file);
    if (existing?.session === ctx.selfId) await fs.unlink(file).catch(() => {});
    ctx.setClaimedTarget(undefined);
    const entry: FleetStateEntry = { kind: "release", target, session: ctx.selfId, ts: Date.now() };
    await appendFleetState(ctx.project, entry).catch(() => {});
    await ctx.send({ channel: "#general", type: "release", payload: { target } }).catch(() => {});
  }

  async function bankFinding(target: string, severity: string, title: string, ref: string): Promise<void> {
    const entry: FleetStateEntry = { kind: "finding", target, session: ctx.selfId, severity, title, ref, ts: Date.now() };
    await appendFleetState(ctx.project, entry).catch(() => {});
    await ctx.send({ channel: "#dup-check", type: "finding", payload: { target, severity, title, ref } }).catch(() => {});
  }

  async function dupCheck(target: string, title: string, rootCause: string, timeoutMs = 5000): Promise<DupCheckResult[]> {
    const requestId = crypto.randomUUID();
    await ctx.send({ channel: "#dup-check", type: "dup_check", payload: { requestId, target, title, rootCause } }).catch(() => {});
    const results = await collectDupCheckResults(ctx, requestId, timeoutMs);
    const entry: FleetStateEntry = { kind: "dup_check", target, session: ctx.selfId, title, rootCause, results, ts: Date.now() };
    await appendFleetState(ctx.project, entry).catch(() => {});
    return results;
  }

  async function handoff(target: string, handoffPath: string): Promise<void> {
    const entry: FleetStateEntry = { kind: "handoff", target, session: ctx.selfId, handoffPath, ts: Date.now() };
    await appendFleetState(ctx.project, entry).catch(() => {});
    await ctx.send({ channel: "#handoff", type: "handoff", payload: { target, handoffPath } }).catch(() => {});
  }

  async function respondToDupCheck(reqMsg: MeshMsg): Promise<void> {
    const p = reqMsg.payload as { requestId?: string; target?: string; title?: string; rootCause?: string };
    if (!p.requestId) return;
    const overlap = await hasOverlappingFinding(ctx.project, p.target, p.title, p.rootCause);
    const result: DupCheckResult & { requestId: string } = { from: ctx.selfId, overlap: overlap.overlap, note: overlap.note, requestId: p.requestId };
    const msg = buildSignedMsg(ctx, reqMsg.from, "dup_check_result", "#dup-check", result);
    await ctx.transportSend(reqMsg.from, { kind: "msg", msg }).catch(() => {});
  }

  return { claimTarget, releaseTarget, bankFinding, dupCheck, handoff, respondToDupCheck };
}

async function collectDupCheckResults(ctx: FleetStateCtx, requestId: string, timeoutMs: number): Promise<DupCheckResult[]> {
  const deadline = Date.now() + timeoutMs;
  const out: DupCheckResult[] = [];
  while (Date.now() < deadline) {
    for (let i = 0; i < ctx.inbound.length; ) {
      const m = ctx.inbound[i];
      if (m.type === "dup_check_result" && (m.payload as { requestId?: string })?.requestId === requestId) {
        ctx.inbound.splice(i, 1);
        const p = m.payload as DupCheckResult & { requestId?: string };
        out.push({ from: m.from, overlap: p.overlap, note: p.note });
      } else { i++; }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return out;
}