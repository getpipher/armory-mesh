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

### Phase 4 — persistence + late-joiner replay (the durable ledger) 🚧
- [ ] `src/persistence.ts` — optional per-channel ndjson log (`logs/<channel>.ndjson`), rotated by size.
- [ ] Cursor-based replay on join (send last-seen cursor → replay from there).
- [ ] `fleet-state.jsonl` — the always-persisted durable ledger (claims + findings + handoffs).

### Phase 5 — fleet-state primitives (the "rich" layer) 🚧
- [ ] `src/fleet-state.ts` — `mesh_claim_target` / `mesh_release_target` / `mesh_bank_finding` / `mesh_dup_check` / `mesh_handoff` / `mesh_fleet_state` / `mesh_channels`.
- [ ] Atomic claim (a target can't be double-claimed; the loser sees the winner via `mesh_list`).
- [ ] `mesh_dup_check` broadcasts on `#dup-check` + `mesh_await` collects `dup_check_result` responses (cross-hunt dup-check).
- [ ] Write-through to `fleet-state.jsonl`.

### Phase 6 — remote transport (the hub) + unified auto-selection 🚧
- [ ] `src/hub.ts` — the HTTP+SSE hub (`bun src/hub.ts`), relays messages + holds the shared registry; LAN mode needs `PI_MESH_AUTH_TOKEN`.
- [ ] `src/transport.ts` — unified auto-selection: same-machine → Unix socket, cross-machine → hub; identical tool API.
- [ ] Mesh relay: a peer relays to an unreachable peer (visited-set + hop-count loop-prevention).
- [ ] Hub failover (standby hub + client fail-over) — Phase 6.5.

### Phase 7 — hardening pass 🚧
- [ ] Per-channel rate cap (default 10 msg/s) + per-message size cap (256KB) enforcement.
- [ ] Fuzz the transport (malformed frames, oversized, replayed nonces, spoofed signatures).
- [ ] Observability hooks — emit `ObsEvent`s compatible with `disler/pi-agent-observability`.
- [ ] Security review: the auth model, the key distribution, the allowlist.

### Phase 8 — dogfood in the bug-bounty fleet 🚧
- [ ] Wire `armory-mesh` into the bug-bounty `.pi/settings.json` packages.
- [ ] Add the "Fleet awareness" contract to `bug-bounty/AGENTS.md` (read `mesh_fleet_state` at startup; `mesh_claim_target`; `mesh_dup_check` before banking/submitting; `mesh_bank_finding`/`mesh_handoff` at milestones).
- [ ] Run the parallel hunts (GMTrade + others) over the mesh; iterate via refining passes.
- [ ] Graduate 🚧 → 🐾 when the dogfooding passes (the mesh holds for days, no ghost peers, no lost fleet state, the dup-check catches real overlap).

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
| 4 persistence + replay | 🚧 | — |
| 5 fleet-state primitives | 🚧 | — |
| 6 remote hub + unified transport | 🚧 | — |
| 7 hardening pass | 🚧 | — |
| 8 dogfood in bug-bounty fleet | 🚧 | the graduation gate |
| 9 publish | 🚧 | — |