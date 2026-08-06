// armory-mesh — auth (by default, even local): project key + allowlist + signed messages + replay protection.
// SCAFFOLD (Phase 0). Phase 1: project key + sign/verify. Phase 7: hardening pass (fuzz, key distribution review).
// See DESIGN.md §3.3 + §5 (the hardened guarantees).

import type { MeshMsg } from "./index.js";

/**
 * Phase 1: the project key — paths.key(project) (32-byte secret, generated on first join, shared
 * out-of-band to peers you want in the pool). The allowlist — paths.allowlist(project) — agent-ids permitted.
 * A peer without the key + allowlist entry cannot join (even on localhost).
 */
export interface Auth {
  ensureKey(): Promise<Buffer>;        // generate if absent; return the project key
  ensureAllowlisted(agentId: string): Promise<boolean>;
  sign(msg: Omit<MeshMsg, "sig">): string; // HMAC-SHA256 over {project, from, channel, type, nonce, payload}
  verify(msg: MeshMsg): boolean;          // true iff sig valid + nonce > last-seen-for-sender
}

export function createAuth(opts: { project: string; selfId: string }): Auth {
  // TODO(Phase 1): implement.
  //   - key: read paths.key(project); generate crypto.randomBytes(32) + write (chmod 600) if absent.
  //   - allowlist: read paths.allowlist(project) (an array of agent-ids); ensure selfId is present (auto-add self on first join? — decide: manual allowlist is safer; lean manual).
  //   - sign: hmac-sha256(key, canonical-json({project, from, channel, type, nonce, payload}))
  //   - verify: recompute + compare; track per-sender nonces (in-memory Map<from, number>) for replay protection.
  void opts;
  throw new Error("createAuth: not implemented (Phase 1)");
}

/** Phase 7: nonce replay protection — reject a nonce <= the last-seen for that sender. */
export class NonceWindow {
  private seen = new Map<string, number>(); // from -> last nonce
  accept(from: string, nonce: number): boolean {
    const last = this.seen.get(from) ?? -1;
    if (nonce <= last) return false;       // replay or reorder — reject
    this.seen.set(from, nonce);
    return true;
  }
}