# armory-mesh — Security Review (Phase 7)

Scope: the auth model, key distribution, allowlist bootstrap, the relay + hub trust models, and the
residual risks. The hardened guarantees live in DESIGN.md §5; this doc reviews how they hold, where
they don't, and what we consciously accept.

---

## 1. Auth model

**Per-project symmetric key + HMAC-SHA256 over every message.**

- The key is 32 random bytes at `~/.pi/mesh/<project>/key` (chmod 600), generated race-safely
  (O_EXCL `"wx"` create — simultaneous starters adopt the winner's key).
- Every `MeshMsg` carries `sig = HMAC-SHA256(key, canonical({project, from, channel, type, nonce, payload}))`.
  Receivers verify with a timing-safe compare; a bad signature is DROPPED (never queued).
- `canonicalString` skips `undefined`-valued keys so the canonical form matches the JSON wire form
  (the Phase 5 bug class — a sig over a field JSON drops would silently reject every message).
- Signature verification happens BEFORE the nonce window (a spoofed frame cannot poison the
  receiver's per-sender nonce state — asserted in smoke-phase7 §2c).

**Replay protection:** per-sender monotonic nonce (`NonceWindow`). A nonce ≤ the last-seen for that
sender is rejected. In-memory per process (a receiver restart resets its window — a replay across a
receiver restart is possible but requires possessing a captured frame AND the key is not needed to
replay; accepted residual risk, bounded by the msg's usefulness window).

**Possession of the key IS the identity bar.** Any process holding the project key can produce
validly-signed messages as ANY `from` id (there is no per-agent key). This is a conscious
fleet-trust model: the key guards the pool, not the individual. Rotating the key (delete the file,
restart the pool) evicts everyone you don't re-invite.

## 2. Key distribution

| Mode | Bootstrap | Notes |
|---|---|---|
| Local (Unix sockets) | The shared filesystem IS the out-of-band channel — every process on the machine running as the same user reads `~/.pi/mesh/<project>/key` (0600). | A rogue process running as ANOTHER user cannot read the key or connect (sockets are 0600 too). |
| Cross-machine (hub) | Manual copy of the key file to each machine (the "invite"). | Future: a `mesh invite` flow could print/export it; not built (dogfood decides). |
| Hub LAN gate | `PI_MESH_AUTH_TOKEN` (constant-time compared) gates every hub endpoint. | The hub NEVER sees the project key — clients verify signatures themselves. |

## 3. Allowlist

Opt-in by design: if `~/.pi/mesh/<project>/allowlist.json` is absent, the key alone gates joining
(key-only mode). If present, it's the authoritative agent-id list. **Bootstrap is manual** — you
write the file before the fleet starts. Residual risk: a key-holder not on the allowlist is
rejected, but nothing distributes the allowlist for you (dogfood may add a `mesh invite` flow).

## 4. Relay trust model (mesh relay, Phase 6.5)

- A relay peer forwards the **original signed MeshMsg untouched** — end-to-end auth holds through
  any number of relay hops.
- `frame.relay = { hops, visited, to }` is **transport-level and NOT signed** (the sender can't
  pre-know the relay path). A malicious relay can: drop frames (always possible), or strip/rewrite
  the visited-set. It CANNOT forge payloads (sig), and it CANNOT loop the mesh: the **hop-count is
  the hard cap** (`config.maxHops`, default 8) and is incremented by every honest relay; a
  visited-stripping relay at worst wastes hops until the cap drops the frame.
- A relay learns message CONTENT (it must, to re-forward it). Relays are pool members — they
  already hold the key. No additional exposure.

## 5. Hub trust model

- The hub is an auth-gated relay + registry + (since 6.5) a **durable store** for persisted-channel
  messages (since Phase 10: disk-backed ndjson, `~/.pi/mesh/hub-store.ndjson`, 0600 — restart-safe;
  `PI_MESH_STORE_PATH=off` reverts to memory-only). It sees every message payload in transit — and
  retains them (bounded, default 1000/channel, file compacted at 16 MB). Since the hub never holds
  the project key it cannot forge, but a hub compromise means: read all traffic + stored history,
  drop/selectively-relay messages, and
  evict peers (liveness DoS). **Run the hub on infrastructure you trust** (the same trust level as
  the fleet).
- Hub traffic is **plain HTTP** (no TLS). A LAN sniffer sees payloads. Accepted for the LAN dogfood;
  if the hub ever leaves the trusted LAN, terminate TLS in front of it (reverse proxy) — no code
  change needed (https: URLs are already supported by the client).

## 6. Flooding + resource bounds

| Vector | Bound |
|---|---|
| Noisy sender | Per-channel token-bucket rate cap (`channelRatePerSec`, default 10 msg/s) on SEND; rejected sends are not persisted. **`#heartbeats` is exempt (control plane)** — a throttled heartbeat would silently evict the peer everywhere; inbound heartbeats are O(1) (they update a live card, they never queue), so the exemption doesn't open a memory flood. |
| Oversized message | `maxMessageBytes` (default 256KB) enforced at BOTH layers: `mesh_send` fails fast with the byte counts; the transport's length-prefix check rejects oversized frames pre-parse (fuzzed in smoke-phase7 §2a). |
| Inbound queue growth | Hard cap 4096 queued msgs (splice-oldest), dedup `seen` set bounded at 8192 ids. |
| Relay loops | Visited-set + hop-count hard cap (§4). |
| Hub memory | Per-channel bounded buffer (default 1000 msgs/channel). |
| Ledger growth | Received findings materialize deduped by (target, title, session). |

## 7. Residual risks (accepted, revisit at dogfood)

1. **Key = identity**: a leaked project key lets a rogue forge as anyone in the pool until rotated.
2. **Plaintext hub transport** on the LAN (§5) — TLS via reverse proxy when needed.
3. **Hub history on the hub's disk** (since Phase 10) — availability now survives restarts, but a
   hub-host compromise reads stored history too (same exposure as §5; keep the store file 0600).
4. **Heartbeat frames are signature-verified but nonce-EXEMPT** (v0.1.2): they're idempotent
   presence data — a captured heartbeat replayed later is harmless (cards are last-write-wins and
   self-heal within one ping interval). This exemption is what keeps stored-message replay possible
   at all: heartbeats sharing the nonce window made reconnect gap back-fill structurally impossible.
5. **Ledger materialization dedup** is check-then-append — two same-machine hub peers materializing
   the same finding concurrently can append it twice (harmless: dup_check is a boolean overlap).
5. **No per-agent identity / signing** — right-sized for a single-operator fleet; revisit if the
   pool ever spans operators.
6. **Nonce windows reset on receiver restart** — cross-restart replays of captured frames are
   possible; bounded by short message usefulness.
