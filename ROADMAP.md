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

### Phase 1 — coms parity (local transport + the 4 core tools) 🚧
**Goal:** match coms's core capability, local-only, hardened baseline.
- [ ] `src/paths.ts` — the `~/.pi/mesh/<project>/` layout (sockets/, agents/, logs/, key, allowlist).
- [ ] `src/transport.ts` — local Unix-socket transport (listen + connect + send/recv + framing + the 256KB cap).
- [ ] `src/registry.ts` — file registry (`agents/<id>.json`), join/leave, `mesh_list`.
- [ ] `src/auth.ts` — project key + HMAC sign/verify + nonce replay protection + allowlist.
- [ ] `src/mesh.ts` — the core: wire the transport + registry + auth into the 4 tools (`mesh_list` / `mesh_send` / `mesh_get` / `mesh_await`).
- [ ] `extensions/mesh.ts` — the pi extension entry: register the tools with the pi tool registry (match the coms/pi extension pattern).
- [ ] **Smoke test:** two `pi -e extensions/mesh.ts` sessions, same machine → `mesh_list` sees both → `mesh_send` round-trips → a killed session is evicted (liveness).
- [ ] Dogfood pass 1: confirm the 4 tools work for 2 parallel pi sessions.

### Phase 2 — liveness + auto-eviction + the live pool widget 🚧
- [ ] Heartbeat loop (`PI_MESH_PING_MS` default 2000) + eviction (`PI_MESH_EVICTION_MISSES` default 5).
- [ ] Context-window-usage broadcast (port coms's approach to reading own context usage).
- [ ] The live pool widget (above the editor): peers + context usage + last-seen, refreshing on heartbeat.
- [ ] Stale-registry cleanup on crash (the coms gap closed).

### Phase 3 — typed messages + channels 🚧
- [ ] `src/channels.ts` — channel registry, subscribe/unsubscribe, per-channel routing.
- [ ] The typed `MsgType` enum + validation (`heartbeat` / `claim` / `release` / `finding` / `dup_check` / `dup_check_result` / `scope` / `learning` / `handoff` / `text`).
- [ ] `mesh_send(channel=..., type=...)`, `mesh_get(channel=, type=)`, `mesh_await(predicate)`.
- [ ] Default channels per project (`#general`, `#dup-check`, `#learnings`, `#handoff`, `#heartbeats`) + on-demand per-target channels (`#gmtrade`).

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
| 1 coms parity (local + 4 tools) | 🚧 next | after the smoke test |
| 2 liveness + widget | 🚧 | — |
| 3 typed messages + channels | 🚧 | — |
| 4 persistence + replay | 🚧 | — |
| 5 fleet-state primitives | 🚧 | — |
| 6 remote hub + unified transport | 🚧 | — |
| 7 hardening pass | 🚧 | — |
| 8 dogfood in bug-bounty fleet | 🚧 | the graduation gate |
| 9 publish | 🚧 | — |