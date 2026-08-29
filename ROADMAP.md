# armory-mesh — Roadmap

**Vision:** a hardened peer-to-peer mesh for pi agents — the in-house answer to disler's `coms`. N-peer mesh, unified transport, liveness, auth, typed channels, persistence, fleet-state primitives. Dogfooded in the bug-bounty fleet, then published.

**Status:** scaffold (2026-08-06). Architecture decided (`DESIGN.md`); implementation phased below.

## Provenance

- 🚧 **NOT-YET-DOGFOODED** — scaffold. Each phase graduates via a dogfooding pass (the bug-bounty fleet) + a `refining`-style reflection.
- The design is the adopted-common-pattern (peer-to-peer agent comms, à la `coms`), tailored + hardened for the getpipher fleet use case.

## Build phases

### Phase 0 — scaffold ✅ (this session, 2026-08-06)
- [x] Repo `getpipher/armory-mesh` (private, in-house) created + cloned.
- [x] `package.json` (`@getpipher/armory-mesh`, `pi.extensions: ["./extensions"]`, peerDeps on pi-ai/pi-coding-agent/typebox, MIT).
- [x] `DESIGN.md` (the full architecture — the coms gaps + the mesh design + the tool API + the hardened guarantees).
- [x] `ROADMAP.md` (this file) + `README.md` + `AGENTS.md`.
- [x] `extensions/mesh.ts` + `src/` stubs (the tool signatures + module boundaries, TODO-marked).

### Phase 1 — coms parity (local transport + the 4 core tools) ✅ (2026-08-10)
**Goal:** match coms's core capability, local-only, hardened baseline.
- [x] `src/paths.ts` — the `~/.pi/mesh/<project>/` layout (sockets/, agents/, logs/, key, allowlist).
- [x] `src/transport.ts` — local Unix-socket transport (listen + connect + 4-byte length-prefixed JSON framing + the 256KB cap; Windows named pipe).
- [x] `src/registry.ts` — file registry (`agents/<id>.json`), join/leave/heartbeat, `refreshPool` with liveness eviction.
- [x] `src/auth.ts` — project key (race-safe O_EXCL gen) + HMAC-SHA256 sign/verify + `NonceWindow` replay protection + opt-in allowlist.
- [x] `src/mesh.ts` — `MeshCore` wires transport + registry + auth into the 4 tools (`mesh_list` / `mesh_send` / `mesh_get` / `mesh_await`); tool descriptors corrected to the real `ToolDefinition` contract (`label` + `execute`).
- [x] `extensions/mesh.ts` — `session_start` → `MeshCore.start`; `session_shutdown`/`SIGINT`/`SIGTERM` → graceful `stop` (release registry + close socket).
- [x] **Smoke test:** `scripts/smoke-phase1.ts` (run via `pnpm test:smoke`) — fake-pi harness (11 tools register) + in-process two-core integration over real sockets (discovery, signed round-trip, tampered drop, crash→eviction). Also confirmed end-to-end through two real `pi -e` sessions (alpha↔beta discovery).
- [x] Dogfood pass 1 gate: the 4 tools work for 2 parallel pi sessions (verified).

**Phase 1 decisions (deviations from the scaffold, documented for Phase 7 hardening):**
- Allowlist is **opt-in**: if `allowlist.json` is absent → key-only mode (the project key is the gate); if present → enforced. The key (shared per-project) is the primary auth — a rogue without it can't produce verifiable messages. Phase 7 revisits allowlist bootstrap.
- The scaffold's tool descriptors used `run` (not the real `execute`) and lacked `label` — they registered but would have thrown at call time. Corrected to the `ToolDefinition` contract.
- Eviction is passive-on-read (`refreshPool`) + self-heartbeat (`setInterval` writing `lastSeen`). The live socket-level ping + pool widget are Phase 2.

### Phase 2 — liveness + auto-eviction + the live pool widget ✅ (2026-08-10)
**Goal:** live liveness (heartbeats) + context-window-usage broadcast + the pool widget.
- [x] Heartbeat loop (`PI_MESH_PING_MS` default 2000) + eviction (`PI_MESH_EVICTION_MISSES` default 5).
- [x] Context-window-usage broadcast (signed `heartbeat` message on `#heartbeats` carrying the agent card; the extension wires `getCtxUsage` to `ctx.getContextUsage()`).
- [x] The live pool widget (below the editor): peers + context usage + claimed-target + last-seen, re-rendered on peer-set change. Defensive `theme.fg` (the getpipher EditorTheme/Theme gotcha).
- [x] Stale-registry cleanup on crash: self-heal (the heartbeat rewrites self's registry file — `writeFile` recreates it if unlinked under us) + Phase-1 `refreshPool` eviction + gossip eviction of silent live cards.
- [x] Smoke tests: `scripts/smoke-phase2.ts` (heartbeat ctx broadcast, gossip eviction, `mesh_list` live view) + `scripts/smoke-phase2-widget.ts` (real `session_start` → `installPoolWidget` → `setWidget` factory → `render` path, no throw).

**Phase 2 design:** liveness is **gossip via signed heartbeat messages** (not socket ping/pong) — reuses the auth + transport, no new round-trip method. Two aligned eviction layers: the registry (file `lastSeen`, Phase 1) + the in-memory `liveCards` (gossip, Phase 2). `mesh_list`/`snapshotPeers` return the merged live view. The pool widget's `render` is synchronous + defensive (no theme API that could throw + crash the TUI, per the cursor gotcha).

### Phase 3 — typed messages + channels ✅ (2026-08-10)
**Goal:** scope comms by channel + enforce typed message payloads.
- [x] `src/channels.ts` — channel registry (self subscriptions), default channels, valid channel names, per-type payload validation, subscriber-based routing.
- [x] The typed `MsgType` validation (`heartbeat` / `claim` / `release` / `finding` / `dup_check` / `dup_check_result` / `scope` / `learning` / `handoff` / `text`); `text` + `heartbeat` are free-form.
- [x] `mesh_send(channel=, type=...)` validates the payload + routes to channel subscribers; `mesh_get(channel=, type=)`, `mesh_await(predicate)` filter by channel/type.
- [x] Default channels per project (`#general`, `#dup-check`, `#learnings`, `#handoff`, `#heartbeats`) joined on start; per-target channels (`#gmtrade`) via `subscribe()` (Phase 5 claim_target uses it; auto-join on send).
- [x] `mesh_channels` tool implemented (channels + live subscriber counts + persist flag).
- [x] Smoke test: `scripts/smoke-phase3.ts` (3 peers) — default broadcast, per-target subscriber-only routing (a non-subscriber doesn't receive), typed validation (valid + invalid), mesh_channels, mesh_await filter.

**Phase 3 design:** channels are subscription-scoped (not just filter tags). Self subscriptions are gossiped via the heartbeat card's `channels` field, so a sender routes a per-target message only to known subscribers (a small fleet doesn't spam uninterested peers). Default channels = everyone subscribed → broadcast-all (same as Phase 1/2). Subscription propagation latency is ≤ pingMs (gossip); Phase 7 may add an immediate subscribe-broadcast.

### Phase 4 — persistence + late-joiner replay (the durable ledger) ✅ (2026-08-10)
**Goal:** a finding broadcast at 02:00 is not lost when a session starts at 09:00.
- [x] `src/persistence.ts` — optional per-channel ndjson logs (`logs/<channel>.ndjson`, rotated by size) + the always-persisted `fleet-state.jsonl` + per-agent cursor files.
- [x] Cursor-based replay on join: a fresh peer reads the shared channel log from its saved cursor (catch-up). Local mode shares the log file across peers (no cross-peer round-trip — the `replay`/`replay-resp` Frame kinds are reserved for Phase 6 cross-machine hub).
- [x] `fleet-state.jsonl` — append + read (the durable ledger; `mesh_fleet_state` reads it). Phase 5 fleet-state primitives write through here.
- [x] Smoke test: `scripts/smoke-phase4.ts` — channel-log write-through, fresh-peer catch-up, **no-receiver-online broadcast is still persisted + caught up** (the 02:00→09:00 scenario), cursor resume (stable id), the fleet-state ledger.

**Phase 4 design:** persistence is **write-through on SEND** (the sender is the authoritative writer) — a finding broadcast with no peer online is still persisted, so a 09:00 session catches up on the 02:00 broadcast. Receivers don't double-persist; replay dedups by msg id. Local mode shares `~/.pi/mesh/<project>/logs/<channel>.ndjson` across peers (O_APPEND = atomic for lines < PIPE_BUF). Cursor resume needs a stable agent id; the extension uses a random uuid per session (so restarts are fresh-cursor full replay — acceptable for the dogfood fleet; Phase 7 may add a stable-id mode for true resume).

### Phase 5 — fleet-state primitives (the “rich” layer) ✅ (2026-08-10)
**Goal:** typed, persisted fleet ops on top of the generic mesh — claim/bank/dup-check/handoff.
- [x] `src/fleet-state.ts` — `createFleetStatePrimitives(ctx)` factory: claimTarget / releaseTarget / bankFinding / dupCheck / handoff + the dup_check auto-responder. MeshCore wires them in.
- [x] Atomic claim (a target can’t be double-claimed) — filesystem lock via O_EXCL (`claims/<target>.json`); first writer wins; a stale claim from an evicted session is reclaimable. The loser sees the holder via mesh_list (`claimedTarget` field, gossiped via heartbeats) + the #general claim broadcast.
- [x] `mesh_dup_check` broadcasts on #dup-check + collects the peers’ `dup_check_result` responses (cross-hunt dup-check — the killer feature for parallel bug-bounty). Responders check their local fleet-state ledger for overlap.
- [x] Write-through to `fleet-state.jsonl` (claim/release/finding/dup_check/handoff). `mesh_fleet_state` reads the ledger (Phase 4).
- [x] Smoke test: `scripts/smoke-phase5.ts` — atomic claim + release + stale reclaim, bank-finding + cross-hunt dup-check (overlap=true + no-overlap=false), handoff, + the ledger records every primitive.

**Phase 5 design:** the primitives are a `createFleetStatePrimitives(ctx)` factory (clean deps via a `FleetStateCtx` interface) so they’re testable in isolation + wired into MeshCore. The dup_check request is auto-answered by the responder (handleFrame intercepts `dup_check` → overlap-check against the local ledger → `dup_check_result` reply) — NOT queued. `mesh_claim_target` uses a filesystem lock (atomic on a single machine); cross-machine atomic claims are a Phase 6 hub concern.

**Critical bug fixed (found via the Phase 5 dup-check round-trip):** `canonicalString` (auth HMAC) included object keys with `undefined` values as `null`, but JSON over the wire DROPS undefined properties — so a heartbeat carrying `claimedTarget: undefined` produced a different canonical string on the sender vs the receiver → signature mismatch → EVERY heartbeat (and every direct reply) was silently dropped. Discovery still worked via the registry fallback (which is why earlier phases’ smoke tests passed), but live context-usage gossip + the dup_check round-trip did not. Fixed by skipping undefined-valued keys in `canonicalString` (so the canonical form matches the JSON wire form). This was a latent bug across ALL phases — the fix retroactively makes the heartbeat/pong gossip + every signed reply actually verify.

### Phase 6 — remote hub + unified transport ✅ (2026-08-10)
**Goal:** cross-machine discovery + message relay via a small HTTP+SSE hub; identical tool API.
- [x] `src/hub.ts` — standalone HTTP+SSE hub (Node `http`, no deps): `/join` `/leave` `/heartbeat` `/send` + `/events` SSE. Holds the live cross-host registry + relays messages. Auth-gated (`X-Mesh-Token`, constant-time; `PI_MESH_AUTH_TOKEN` required). Hub-side liveness eviction. Runnable standalone (`node --import <jiti>/lib/jiti-register.mjs src/hub.ts`).
- [x] `src/transport.ts` — `createHubTransport`: SSE inbound (frames + peer events, auto-reconnect) + HTTP POST outbound (join/leave/heartbeat/send). Implements **both** `Transport` + `Registry` (in hub mode the MeshCore uses one object for both — the hub holds the live registry; no local file registry).
- [x] Unified auto-selection in `createMeshCore`: `config.hubUrl` set → hub transport + hub registry; else local Unix-socket transport + file registry. The tool API (`mesh_send` etc.) is identical either way.
- [ ] Mesh relay (hub-less cross-machine, visited-set + hop-count loop-prevention) — **deferred to Phase 6.5**.
- [ ] Hub failover (standby hub + client fail-over) — **deferred to Phase 6.5**.
- [x] Smoke test: `scripts/smoke-phase6.ts` — in-process hub + two hub-mode cores: discovery via SSE, signed round-trip through the hub, `#general` broadcast, auth gate (no/wrong/correct token → 401/401/200), hub-side eviction of a crashed peer.

**Phase 6 design:** the hub is a **dumb relay** — it never sees the project key; messages stay signed + nonce-protected (peers verify on receive). The hub only needs `PI_MESH_AUTH_TOKEN` (the LAN gate). Defense in depth: a rogue can't join without the token, AND couldn't forge signed messages even if it could. The HubTransport doubles as the registry (the hub holds the live peer list; SSE `peer-joined/left/updated` events keep each peer's view current). **Known limitation (Phase 6.5):** channel logs are per-machine local files, so cross-machine late-joiner catch-up (a peer on machine X replaying messages persisted on machine Y) isn't solved by the hub relay alone — the hub doesn't store messages. The `replay`/`replay-resp` Frame kinds (reserved since Phase 4) are the planned fix, or the hub stores+replays.

### Phase 6.5 — mesh relay + hub failover + cross-machine replay ✅ (2026-08-11)
**Goal:** close the cross-machine gaps left open by Phase 6 — hub-less mesh relay (loop-prevention),
standby-hub failover, + cross-machine late-joiner replay.
- [x] **Mesh relay** (DESIGN §3.1/§5.5): a `relay` field on the `Frame` (transport-level, NOT part of the
  signed `MeshMsg`) carries `{ hops, visited, to }`. `MeshCore.send({target})` tries direct; on failure
  (or a peer in `config.unreachablePeers` — e.g. a git-synced local-mode peer on another machine)
  it relays via a live peer. `handleFrame` processes in-transit relay frames: deliver directly (strip
  relay), re-relay via a non-visited peer (hops+1), or drop at `config.maxHops`. The visited-set +
  hop-count are the loop-prevention guarantee. A relay peer forwards the original SIGNED message
  untouched (end-to-end auth; the relay metadata is unsigned but hop-count bounds abuse).
- [x] **Hub failover** (DESIGN §5.7): `config.hubUrls` (ordered failover chain; overrides `hubUrl`). The
  `HubTransport` tracks `consecutiveFailures`; after `config.hubFailoverThreshold` (default 3) SSE
  close/error events it rotates to the next hub (round-robin) + re-registers. A `reconnectPending`
  guard prevents double-scheduling when both `close` + `error` fire for one failure.
- [x] **Cross-machine late-joiner replay** (DESIGN §3.5): the hub stores persisted-channel messages
  in an in-memory bounded buffer (`HubOpts.persistChannels` / `maxChannelLogEntries`, default 1000).
  On `/join` the peer sends its per-channel cursors; the hub flushes `replay` SSE events for stored
  msgs with `ts > cursor`. The `HubTransport` forwards replay frames to `handleFrame` (kind `"replay"`),
  which verifies + dedups (markSeen) + queues each — the 02:00→09:00 cross-machine scenario. In hub
  mode, broadcasts now use one `POST /send` (the hub routes + stores) so an alone sender's finding
  still reaches the durable store.
- [x] Smoke test: `scripts/smoke-phase6_5.ts` — relay delivery (A→B→C with A partitioned from C) +
  loop-prevention (undeliverable target drops at maxHops, no hang/crash); hub failover (stop hub1 →
  both rotate to hub2 + round-trip); cross-machine replay (A broadcasts alone → hub stores → B
  starts later + receives; a forward-cursor late-joiner does NOT re-receive).

**Phase 6.5 design:** the relay is a best-effort fallback on direct-transport failure (the trigger
is `transport.send` throwing / a known-unreachable peer). Loop-prevention is the hardened guarantee
— the visited-set stops re-relaying to peers already in the path; the hop-count is the hard cap.
Hub failover rotates the whole transport (SSE + POST base) to the next hub; the new hub replays its
own buffer (dedup handles overlap with the prior hub). Cross-machine replay puts the hub in the
durable-store role for hub mode (local mode still uses the shared filesystem log); messages stay
signed end-to-end (the hub stores opaque signed payloads it already sees in transit).

**Known limitations (Phase 7/8):**
- `fleet-state.jsonl` is still PER-MACHINE. The hub stores CHANNEL messages (so `mesh_get` is
  cross-machine) but not the fleet-state ledger. Cross-machine `mesh_dup_check` therefore checks only
  the local ledger — a finding banked on machine Y isn't in machine X's overlap check unless X also
  received + materialized it. Fix options for Phase 7/8: materialize received `finding` msgs into the
  local ledger, OR have the hub store fleet-state too. (The channel broadcast + replay already make
  the finding VISIBLE cross-machine via `mesh_get({channel:"#dup-check"})`.)
- Reconnect/failover re-joins with `cursors: {}` (full replay); the `replayed` flag on the hub's HubPeer
  suppresses replay on reconnect-to-same-hub, so a genuine disconnect gap (msgs sent while the SSE
  was down) is not back-filled except on failover to a fresh hub. Phase 7 could pass live cursors on
  reconnect + reset the `replayed` flag.
- Hub channel logs are in-memory only (lost on hub restart); a long-running dogfood may want a
  disk-backed hub store (Phase 7).

### Phase 7 — hardening pass ✅ (2026-08-11)
**Goal:** enforce the remaining DESIGN §5 guarantees (size + rate caps, observability), fuzz the
transport, security-review the stack, + close the feasible Phase 6.5 gaps.
- [x] Per-message size cap: `mesh_send` pre-serializes + fails fast with byte counts (`message
  exceeds cap (N > M bytes)`); the transport's length-prefix check already rejects oversized frames
  pre-parse. Both layers fuzzed.
- [x] Per-channel rate cap: token bucket per channel (`channelRatePerSec`, default 10 msg/s) on
  SEND — burst up to the rate, refill continuously; rejected sends throw a clear error + are NOT
  persisted. **`#heartbeats` is exempt (control plane)** — a throttled heartbeat would silently
  evict the peer from every pool; inbound heartbeats are O(1) so the exemption opens no flood.
- [x] Transport fuzz (`scripts/smoke-phase7.ts`): raw-frame injection via the same primitives a
  rogue local process would use — oversized length prefix (rejected pre-parse), malformed JSON
  (dropped, peer keeps serving), spoofed signature (dropped BEFORE the nonce window — no nonce
  poisoning), replayed nonce (arrives exactly once). Peer survives every case.
- [x] Observability hooks: `ObsEvent` (flat + queryable, `source_app`/`session_id`/`event_type`/
  `timestamp` + event-specific TOP-LEVEL fields — the disler/pi-agent-observability hook-event
  shape) + `core.onObs` sink. Emitted: `mesh_send` / `mesh_receive` / `mesh_relay` (both sender
  + relay-peer sides) / `mesh_replay` / `mesh_evict` / `mesh_drop` (bad-signature, duplicate,
  rate-limit, oversize, hop-limit, no-relay-peer). Observability can never break the mesh
  (sink throws are swallowed).
- [x] Security review: `SECURITY.md` — auth model (key=identity, sig-before-nonce), key
  distribution table (local/hub/LAN gate), allowlist bootstrap, relay trust (unsigned metadata,
  hop-count as the hard cap), hub trust (relay + store, plain-HTTP residual), flooding bounds,
  residual risks.
- [x] Phase 6.5 gap (a) — cross-machine fleet-state: received `finding` msgs are MATERIALIZED into
  the local ledger (hub mode only — local mode shares one ledger file) with dedup by
  (target, title, session). A finding banked on machine Y now feeds machine X's `mesh_dup_check`
  overlap check. Smoke: hub replay → materialized → `mesh_dup_check` returns overlap=true; a
  re-received finding does NOT duplicate the entry.
- [x] Phase 6.5 gap (b) — reconnect cursors: the hub transport re-joins with the LIVE cursors
  (`getCursors`) on reconnect, + the hub's `/join` resets the `replayed` flag so the disconnect gap
  is re-flushed (back-fill) instead of silently skipped.
- [ ] Phase 6.5 gap (c) — hub disk-backed store: DEFERRED to Phase 8 (in-memory is fine for a LAN
  hub that stays up; the dogfood decides if a restart-durable hub store is worth the complexity).

**Phase 7 design:** the rate cap is OUTBOUND-only (the sender-side control; inbound is already
bounded by the queue cap). Sig verification ordering (before nonce) is load-bearing — a spoofed
frame must not advance the receiver's nonce window (else an attacker could lock a sender out by
burning its nonces). Materialization is hub-mode-only: local mode shares one ledger file per
machine, so receiver-side writes would just double-write it.

### Phase 8 — dogfood in the bug-bounty fleet 🚧 (wired + live-verified 2026-08-11)
- [x] Wire armory-mesh into the bug-bounty fleet: per-hunt `.pi/settings.json` (`~/local-dev/getpipher/armory-mesh`
  in packages — pi reads project settings from the session cwd ONLY, no ancestor cascade) + bucket-level
  `.pi/mesh.json` (`project: "bug-bounty-fleet"` + persistChannels — discovered by the extension's new
  nearest-ancestor walk, so every hunt joins ONE pool automatically).
- [x] Extension feature (dogfood-driven): `findMeshConfig` — nearest-ancestor `.pi/mesh.json` discovery
  (precedence: env > mesh.json > cwd basename). Unit-checked + live-verified.
- [x] "Fleet awareness" contract in `bug-bounty/AGENTS.md`: mesh_fleet_state at startup;
  mesh_claim_target before hunting; mesh_dup_check before submitting; mesh_bank_finding/mesh_handoff
  at milestones. Ops notes incl. the per-hunt wiring requirement + the rextor-has-the-same-gap flag.
- [x] Live verification (two real `pi` sessions in different hunt folders): mutual discovery + the
  pool widget (live context + claimed-target), claim conflict enforced (second claimant LOST), and
  cross-hunt `mesh_dup_check` → `overlap: true` from the peer's auto-responder. The killer feature
  works end-to-end in real TUIs.
- [ ] **The graduation gate itself: the days-long run.** RECTOR runs the parallel hunts over the
  mesh; graduate 🚧→🐾 when it holds for days (no ghost peers, no lost fleet state, dup-check catches
  real overlap). Hub disk-backed store: build only if the long run hits hub-restart data loss.

### Phase 9 — publish 🚧
- [ ] Flip the repo to public (`gh repo edit getpipher/armory-mesh --visibility public`).
- [ ] npm-publish `@getpipher/armory-mesh` (account `rz1989`).
- [ ] README polish + a demo (two sessions, the live pool widget, a `mesh_dup_check` round-trip).

## Status per phase
| Phase | Status | Dogfooded? |
|---|---|---|
| 0 scaffold | ✅ done (this session) | n/a |
| 1 coms parity (local + 4 tools) | ✅ done (2026-08-10) | smoke test passed; real 2-session run |
| 2 liveness + widget | ✅ done (2026-08-10) | smoke2 + widget smoke passed |
| 3 typed messages + channels | ✅ done (2026-08-10) | smoke3 passed |
| 4 persistence + replay | ✅ done (2026-08-10) | smoke4 passed |
| 5 fleet-state primitives | ✅ done (2026-08-10) | smoke5 passed |
| 6 remote hub + unified transport | ✅ done (2026-08-10) | smoke6 passed; mesh relay + failover deferred to 6.5 |
| 6.5 mesh relay + hub failover + cross-machine replay | ✅ done (2026-08-11) | smoke6_5 passed (relay + loop-prevention, failover, replay) |
| 7 hardening pass | ✅ done (2026-08-11) | smoke7 passed (size cap, fuzz, rate cap, obs events, materialization) |
| 8 dogfood in bug-bounty fleet | 🚧 wired + live-verified (2026-08-11) | 2 real sessions: discovery, widget, claim conflict, cross-hunt dup-check overlap — gate: the days-long run |
| 9 publish | 🚧 | — |