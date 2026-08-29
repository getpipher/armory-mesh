// armory-mesh — /mesh doctor: install + runtime diagnostics.
// See ROADMAP.md Phase 8 (dogfood refine). The checks mirror the failure chain we debugged live:
// cwd package wiring → trust → project key → self registration → transport (socket | hub) →
// peers → claims → ledger. runDoctor takes INJECTED deps (paths, peer list, hub reachability) so
// the smoke can fabricate state; extensions/mesh.ts wires the real session into it.
//
// Doctor NEVER throws: every probe is wrapped; a probe that errors becomes a "fail" check with the
// error in the detail. Output is a flat check list rendered by formatDoctorReport (✓/⚠/✗ + hints).

import fs from "node:fs";
import path from "node:path";
import { findMeshConfigPath } from "./config.js";
import type { Peer, MeshConfig } from "./index.js";

export type DoctorStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail?: string;
  hint?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** How this session resolved its project id (informative). */
  joinedVia: string;
  mode: "local" | "hub";
  project: string;
}

export interface DoctorDeps {
  cwd: string;
  project: string;
  selfId: string;
  selfName: string;
  coreStarted: boolean;
  mode: "local" | "hub";
  config: Pick<MeshConfig, "pingMs" | "evictionMisses" | "maxMessageBytes" | "channelRatePerSec" | "maxHops" | "persistChannels"> & { hubFailoverThreshold?: number };
  hubUrls?: string[];
  listPeers(): Promise<Peer[]>;
  /** The mesh state root (~/.pi/mesh). Injectable for tests. */
  meshRoot: string;
  /** Absolute path to pi's trust.json (~/.pi/agent/trust.json). Injectable for tests. */
  trustFile: string;
  env: { PI_MESH_PROJECT?: string; PI_MESH_AGENT_NAME?: string };
  now?: number;
  /** Hub-mode reachability probe (injected; default in the extension = short-timeout fetch). */
  hubFetch?: () => Promise<boolean>;
}

function check(id: string, label: string, status: DoctorStatus, detail?: string, hint?: string): DoctorCheck {
  return { id, label, status, detail, hint };
}

/** Read <cwd>/.pi/settings.json; return {packages} or null. Never throws. */
function readCwdPackages(cwd: string): string[] | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, ".pi", "settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as { packages?: unknown };
    if (Array.isArray(parsed.packages)) return parsed.packages.filter((p): p is string => typeof p === "string");
    return [];
  } catch {
    return null;
  }
}

/** Walk cwd → root in the trust table: nearest decision (true/false) or undefined. */
function nearestTrustDecision(trustFile: string, cwd: string): { decision: boolean; at?: string } | undefined {
  let raw: string;
  try { raw = fs.readFileSync(trustFile, "utf-8"); } catch { return undefined; }
  let table: Record<string, unknown>;
  try { table = JSON.parse(raw) as Record<string, unknown>; } catch { return undefined; }
  let cur = cwd;
  for (;;) {
    const v = table[cur];
    if (typeof v === "boolean") return { decision: v, at: cur };
    const parent = path.dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const now = deps.now ?? Date.now();
  const checks: DoctorCheck[] = [];
  const projDir = path.join(deps.meshRoot, deps.project);
  const staleAfterMs = deps.config.pingMs * deps.config.evictionMisses;

  // ── Join source (informative) ─────────────────────────────────────────
  let joinedVia: string;
  if (deps.env.PI_MESH_PROJECT) joinedVia = `env (PI_MESH_PROJECT=${deps.env.PI_MESH_PROJECT})`;
  else {
    const meshJson = findMeshConfigPath(deps.cwd);
    joinedVia = meshJson ? `.pi/mesh.json at ${path.dirname(path.dirname(meshJson))}` : `cwd basename (${deps.cwd})`;
  }

  // ── cwd package wiring ────────────────────────────────────────────────
  try {
    const pkgs = readCwdPackages(deps.cwd);
    if (pkgs === null) {
      checks.push(check("wiring", "Package wiring (cwd .pi/settings.json)", "warn",
        "no .pi/settings.json in this folder", "this session loaded the mesh via -e or user scope — NEW sessions here won't. Copy a per-hunt .pi/settings.json with ~/local-dev/getpipher/armory-mesh in packages"));
    } else if (pkgs.some((p) => p.includes("armory-mesh"))) {
      checks.push(check("wiring", "Package wiring (cwd .pi/settings.json)", "ok", pkgs.filter((p) => p.includes("armory-mesh")).join(", ")));
    } else {
      checks.push(check("wiring", "Package wiring (cwd .pi/settings.json)", "warn",
        "settings exist but no armory-mesh entry", "add ~/local-dev/getpipher/armory-mesh to .pi/settings.json packages (new sessions here won't load the mesh)"));
    }
  } catch (e) {
    checks.push(check("wiring", "Package wiring (cwd .pi/settings.json)", "fail", String(e)));
  }

  // ── Trust ─────────────────────────────────────────────────────────────
  try {
    const t = nearestTrustDecision(deps.trustFile, deps.cwd);
    if (t === undefined) {
      checks.push(check("trust", "Project trust", "warn", "no saved decision for this folder or any parent",
        "run /trust in this session (or add the folder to ~/.pi/agent/trust.json) — untrusted projects silently skip project packages"));
    } else if (t.decision) {
      checks.push(check("trust", "Project trust", "ok", t.at === deps.cwd ? "this folder" : `inherited from ${t.at}`));
    } else {
      checks.push(check("trust", "Project trust", "fail", `marked untrusted at ${t.at}`,
        "re-trust: /trust, or set the folder to true in ~/.pi/agent/trust.json"));
    }
  } catch (e) {
    checks.push(check("trust", "Project trust", "fail", String(e)));
  }

  // ── Project key ───────────────────────────────────────────────────────
  try {
    const keyPath = path.join(projDir, "key");
    if (!fs.existsSync(keyPath)) {
      checks.push(check("key", "Project key", "fail", `missing at ${keyPath}`,
        "the key is created on first join — a missing key with a live session usually means the PROJECT resolved differently (check the pool name above)"));
    } else {
      const stat = fs.statSync(keyPath);
      if (stat.size < 16) {
        checks.push(check("key", "Project key", "fail", `undersized (${stat.size} bytes)`, "delete the key file and let a session re-create it (all peers must re-copy it)"));
      } else if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
        checks.push(check("key", "Project key", "warn", `perms ${((stat.mode & 0o777) >>> 0).toString(8)} (expected 600)`, "chmod 600 the key — it is the pool's identity secret"));
      } else {
        checks.push(check("key", "Project key", "ok", `${stat.size} bytes, 0600`));
      }
    }
  } catch (e) {
    checks.push(check("key", "Project key", "fail", String(e)));
  }

  // ── Self registration ─────────────────────────────────────────────────
  try {
    const selfFile = path.join(projDir, "agents", `${deps.selfId}.json`);
    if (!fs.existsSync(selfFile)) {
      checks.push(check("self", "Self registration", deps.coreStarted ? "fail" : "warn",
        deps.coreStarted ? "this session is NOT in the pool registry" : "core not started",
        deps.coreStarted ? "self-heals on the next heartbeat — if it persists, the project resolved differently (see join source)" : undefined));
    } else {
      const self = JSON.parse(fs.readFileSync(selfFile, "utf-8")) as { lastSeen?: number; name?: string };
      const age = now - (self.lastSeen ?? 0);
      if (age > staleAfterMs) {
        checks.push(check("self", "Self registration", "warn", `lastSeen ${Math.round(age)}ms ago (> eviction window ${staleAfterMs}ms)`, "the heartbeat loop may be stalled"));
      } else {
        checks.push(check("self", "Self registration", "ok", `${self.name ?? deps.selfName}, lastSeen ${Math.max(0, Math.round(age))}ms ago`));
      }
    }
  } catch (e) {
    checks.push(check("self", "Self registration", "fail", String(e)));
  }

  // ── Transport: socket (local) | hub (hub) ─────────────────────────────
  if (deps.mode === "local") {
    try {
      const sock = path.join(projDir, "sockets", `${deps.selfId}.sock`);
      checks.push(check("socket", "Unix socket (local mode)", fs.existsSync(sock) ? "ok" : "warn",
        fs.existsSync(sock) ? sock : "socket file missing (Windows named pipes don't leave one — informational)", "missing on a live Unix session: the transport may have failed to bind"));
    } catch (e) {
      checks.push(check("socket", "Unix socket (local mode)", "fail", String(e)));
    }
  } else {
    try {
      const reachable = deps.hubFetch ? await deps.hubFetch() : false;
      checks.push(check("hub", "Hub reachability", reachable ? "ok" : "fail",
        (deps.hubUrls ?? []).join(", ") || "(no hubUrls)",
        reachable ? undefined : "is the hub running (PI_MESH_AUTH_TOKEN set)? can this machine reach it?"));
    } catch (e) {
      checks.push(check("hub", "Hub reachability", "fail", String(e)));
    }
  }

  // ── Peers ─────────────────────────────────────────────────────────────
  try {
    const peers = await deps.listPeers();
    checks.push(check("peers", "Live peers", "ok",
      peers.length === 0 ? "solo (no other peers)" : peers.map((p) => `${p.name} (${p.id.slice(0, 8)})${p.claimedTarget ? ` ⟨${p.claimedTarget}⟩` : ""}`).join(", ")));
  } catch (e) {
    checks.push(check("peers", "Live peers", "fail", String(e)));
  }

  // ── Claims (live vs reclaimable) ──────────────────────────────────────
  try {
    const claimsDir = path.join(projDir, "claims");
    let active = 0;
    let reclaimable = 0;
    if (fs.existsSync(claimsDir)) {
      for (const f of fs.readdirSync(claimsDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const claim = JSON.parse(fs.readFileSync(path.join(claimsDir, f), "utf-8")) as { session?: string; target?: string };
          const holderFile = path.join(projDir, "agents", `${claim.session}.json`);
          let holderAlive = false;
          try {
            const holder = JSON.parse(fs.readFileSync(holderFile, "utf-8")) as { lastSeen?: number };
            holderAlive = now - (holder.lastSeen ?? 0) <= staleAfterMs;
          } catch { /* holder gone */ }
          if (holderAlive) active++; else reclaimable++;
        } catch { /* skip malformed claim */ }
      }
    }
    checks.push(check("claims", "Target claims", "ok",
      `${active} active${reclaimable > 0 ? `, ${reclaimable} reclaimable (holder evicted — mesh_claim_target reclaims)` : ""}`));
  } catch (e) {
    checks.push(check("claims", "Target claims", "fail", String(e)));
  }

  // ── Ledger + persisted channel logs ───────────────────────────────────
  try {
    const ledger = path.join(projDir, "fleet-state.jsonl");
    let entries = 0;
    if (fs.existsSync(ledger)) {
      entries = fs.readFileSync(ledger, "utf-8").split("\n").filter((l) => l.trim()).length;
    }
    const logs = path.join(projDir, "logs");
    const logSizes: string[] = [];
    if (fs.existsSync(logs)) {
      for (const f of fs.readdirSync(logs)) {
        const s = fs.statSync(path.join(logs, f));
        logSizes.push(`${decodeURIComponent(f.replace(/\.ndjson$/, ""))} ${(s.size / 1024).toFixed(1)}KB`);
      }
    }
    checks.push(check("ledger", "Durable ledger", "ok",
      `${entries} fleet-state entries${logSizes.length ? ` · logs: ${logSizes.join(", ")}` : " · no channel logs yet"}`));
  } catch (e) {
    checks.push(check("ledger", "Durable ledger", "fail", String(e)));
  }

  // ── Config echo (informative) ─────────────────────────────────────────
  checks.push(check("config", "Config", "ok",
    `rate ${deps.config.channelRatePerSec}/s · size cap ${deps.config.maxMessageBytes}B · maxHops ${deps.config.maxHops} · persist: ${deps.config.persistChannels.join(", ") || "none"}`));

  return { checks, joinedVia, mode: deps.mode, project: deps.project };
}

/** Render a DoctorReport as a ✓/⚠/✗ text block (what /mesh doctor notifies). */
function formatDoctorReport(report: DoctorReport): string {
  const icon = (s: DoctorStatus) => (s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗");
  const lines: string[] = [];
  lines.push(`mesh doctor — project "${report.project}" (${report.mode} mode)`);
  lines.push(`joined via: ${report.joinedVia}`);
  lines.push("");
  for (const c of report.checks) {
    lines.push(`${icon(c.status)} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
    if (c.hint && c.status !== "ok") lines.push(`    ↳ ${c.hint}`); // hints only matter when something needs attention
  }
  const fails = report.checks.filter((c) => c.status === "fail").length;
  const warns = report.checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(fails === 0 && warns === 0 ? "all checks passed" : `${fails} fail, ${warns} warn`);
  return lines.join("\n");
}

export { runDoctor, formatDoctorReport };