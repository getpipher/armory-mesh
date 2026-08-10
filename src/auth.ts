// armory-mesh — auth (by default, even local): project key + allowlist + signed messages + replay protection.
// See DESIGN.md §3.3 + §5 (the hardened guarantees).
//
// Auth model (Phase 1):
//   - Per-project key at paths.key(project) — 32 random bytes, generated on first join, chmod 600.
//     On a single machine the key file is shared by all peers in the project (the filesystem *is*
//     the out-of-band channel). Cross-machine you copy the key (Phase 6 hub + PI_MESH_AUTH_TOKEN).
//   - The key is the primary auth gate: a message whose HMAC doesn't verify (wrong/no key) is DROPPED.
//     This is "auth by default" — a rogue pi session without the key can't produce verifiable messages.
//   - Allowlist (paths.allowlist(project)) is OPT-IN: if the file is absent, key-only mode (any peer
//     holding the key can join); if present, it's the authoritative list of permitted agent-ids.
//     Phase 7 hardening revisits key distribution + allowlist bootstrap.
//   - Signed messages: HMAC-SHA256 over the canonical encoding of {project, from, channel, type, nonce, payload}.
//   - Replay protection: per-sender monotonic nonce; receivers reject nonce <= last-seen for that sender.
//
// Nonce across restarts: agent ids are random per session (crypto.randomUUID in the extension), so a
// restarted session is a fresh sender with its own nonce window — no cross-session replay window.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import { paths, projectDir } from "./paths.js";
import type { MeshMsg } from "./index.js";

/** Canonical, stable string encoding for HMAC: sorted keys, no insignificant whitespace. */
function canonicalString(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalString).join(",") + "]";
  }
  if (typeof value === "object" && value !== undefined) {
    // Skip keys whose value is undefined so the canonical form matches the JSON wire form
    // (JSON.stringify drops undefined-valued object properties; a sig computed over a payload
    // with an undefined field would otherwise mismatch the receiver's parsed payload).
    const keys = Object.keys(value as Record<string, unknown>).filter((k) => (value as Record<string, unknown>)[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalString((value as Record<string, unknown>)[k])).join(",") + "}";
  }
  return "null";
}

/** The fields covered by the HMAC — matches DESIGN.md §3.3 exactly. */
function signedFields(project: string, msg: Pick<MeshMsg, "from" | "channel" | "type" | "nonce" | "payload">): unknown {
  return { project, from: msg.from, channel: msg.channel ?? null, type: msg.type, nonce: msg.nonce, payload: msg.payload };
}

/** Phase 7: nonce replay protection — reject a nonce <= the last-seen for that sender. */
export class NonceWindow {
  private seen = new Map<string, number>(); // from -> last accepted nonce
  /** Returns true iff nonce is strictly greater than the last-seen for this sender. */
  accept(from: string, nonce: number): boolean {
    const last = this.seen.get(from) ?? -1;
    if (nonce <= last) return false; // replay or reorder — reject
    this.seen.set(from, nonce);
    return true;
  }
}

export interface Auth {
  ensureKey(): Promise<Buffer>;
  ensureAllowlisted(agentId: string): Promise<boolean>;
  sign(msg: Pick<MeshMsg, "from" | "channel" | "type" | "nonce" | "payload">): string;
  verify(msg: MeshMsg): boolean;
  /** Allow the mesh to reuse the project string passed at construction. */
  readonly project: string;
}

export function createAuth(opts: { project: string; selfId: string }): Auth {
  const { project, selfId } = opts;
  let key: Buffer | null = null;
  const nonceWindow = new NonceWindow();

  async function ensureKey(): Promise<Buffer> {
    if (key) return key;
    const p = paths.key(project);
    await fs.mkdir(projectDir(project), { recursive: true });
    // Fast path: the key already exists (common case — a second peer joining).
    try {
      const data = await fs.readFile(p);
      key = Buffer.from(data);
      if (key.length < 16) throw new Error("project key too short");
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    // Race-safe generation: O_EXCL ("wx") create. If two peers start truly simultaneously,
    // only one wins the create; the other re-reads the winner's key (so all peers share one key).
    const generated = crypto.randomBytes(32);
    try {
      const fh = await fs.open(p, "wx", 0o600);
      await fh.writeFile(generated);
      await fh.close();
      key = generated;
      return key;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Another peer created the key first — adopt it.
      const data = await fs.readFile(p);
      key = Buffer.from(data);
      if (key.length < 16) throw new Error("project key too short");
      return key;
    }
  }

  async function ensureAllowlisted(agentId: string): Promise<boolean> {
    const p = paths.allowlist(project);
    try {
      const raw = await fs.readFile(p, "utf-8");
      const list = JSON.parse(raw);
      if (!Array.isArray(list)) return false;
      // Self is always permitted once the key is held — this lets the bootstrap peer join.
      return list.includes(agentId) || agentId === selfId;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // No allowlist file => key-only mode (the default). Possession of the project key is the gate.
        return true;
      }
      throw err;
    }
  }

  function sign(msg: Pick<MeshMsg, "from" | "channel" | "type" | "nonce" | "payload">): string {
    if (!key) throw new Error("auth: project key not loaded — call ensureKey() first");
    const body = canonicalString(signedFields(project, msg));
    return crypto.createHmac("sha256", key).update(body, "utf8").digest("hex");
  }

  function verify(msg: MeshMsg): boolean {
    if (!key) return false; // a session that never loaded the key can't verify either
    const expected = sign(msg);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(msg.sig ?? "", "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false; // bad signature → drop
    // Replay protection: nonce must advance per sender.
    if (!nonceWindow.accept(msg.from, msg.nonce)) return false;
    return true;
  }

  return {
    ensureKey,
    ensureAllowlisted,
    sign,
    verify,
    get project() {
      return project;
    },
  };
}