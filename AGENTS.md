# armory-mesh — Project Context (for build sessions)

> **armory-mesh** is `@getpipher/armory-mesh` — a hardened peer-to-peer mesh for pi agents. The in-house answer to disler's `coms`. Loaded as a pi extension. Dogfooded in the bug-bounty fleet, then published.

## What this is

A pi extension package that lets N parallel pi sessions talk to each other **peer-to-peer** (equal agents, no orchestrator), live, so a fleet of hunts (or any parallel work) is mutually aware in real time. The hardened + richer evolution of `coms` — mesh routing, liveness + auto-eviction, unified transport (local ↔ remote), built-in auth (signed + replay-protected), typed messages + channels, optional persistence + late-joiner replay, and fleet-state primitives (claim/bank/dup-check/handoff).

## Current state (2026-08-06)

🚧 **scaffold.** Phase 0 done:
- Repo `getpipher/armory-mesh` (private, in-house) created + cloned to `~/local-dev/getpipher/armory-mesh/`.
- `package.json` (`@getpipher/armory-mesh`, `pi.extensions: ["./extensions"]`, peerDeps on pi-ai/pi-coding-agent/typebox, MIT).
- `DESIGN.md` (the full architecture — the coms gaps + the mesh design + the tool API + the hardened guarantees — **READ FIRST on any build session**).
- `ROADMAP.md` (the 10 build phases; Phase 1 is next).
- `README.md` + this `AGENTS.md`.
- `extensions/mesh.ts` + `src/` stubs (the tool signatures + module boundaries, TODO-marked).

**Next:** Phase 1 (coms parity: local Unix-socket transport + registry + auth + the 4 core tools `mesh_list`/`mesh_send`/`mesh_get`/`mesh_await`) + the smoke test (two `pi -e extensions/mesh.ts` sessions, confirm `mesh_list` + `mesh_send` round-trip + a killed session is evicted).

## How to build (the discipline)

1. **Read `DESIGN.md` first** — the architecture is decided; build against it, don't re-derive.
2. **Follow `ROADMAP.md`** — phase by phase. Each phase has a smoke test / dogfooding gate before the next.
3. **Match the getpipher package convention** — `@getpipher/armory-*`, `pi.extensions: ["./extensions"]`, `src/` modules, MIT, peerDeps on pi-ai/pi-coding-agent/typebox. See `~/local-dev/getpipher/armory-todo/` as the reference package.
4. **Reference `coms`** — `disler/pi-vs-claude-code`, `extensions/coms.ts` (51KB). The peer-to-peer pattern, the pool widget, the context-usage broadcast, the keepalive. Don't copy blindly — harden (the DESIGN.md gaps).
5. **TypeScript, no build step** — pi loads the `.ts` source directly (the armory-* convention). `type: module`. No compiled output; `src/index.ts` is the export entry.
6. **Dogfood in the bug-bounty fleet** — Phase 8. The graduation gate: the mesh holds for days, no ghost peers, no lost fleet state, the cross-hunt `mesh_dup_check` catches real overlap. Then publish (Phase 9).

## The hardened guarantees (never compromise these)

- **Auth by default** — no peer joins without the project key + allowlist, even on localhost.
- **Signed + replay-protected** — every message HMAC'd; nonces monotonic per sender.
- **Liveness + auto-eviction** — dead peers evicted, no ghosts.
- **Fleet state is never lost** — claims/findings/handoffs write-through to `fleet-state.jsonl` even if messaging is ephemeral.
- **Mesh relay with loop-prevention** — visited-set + hop-count; no infinite relay loops.
- **Size + rate caps** — per-message (256KB) + per-channel (10 msg/s) defaults; a noisy peer can't drown the pool.

## Conventions

- **2-space indent, meaningful names, comments only for complex logic** (the CIPHER dev standard).
- **No AI attribution** in commits/PRs/docs.
- **One commit per phase/feature** — small focused commits.
- **Private repo** until Phase 9 (publish). MIT license ready.

## The coms reference (the thing we're beating)

`disler/pi-vs-claude-code`, `extensions/coms.ts`:
- N-peer pool (NOT 2-capped; bounded by `MAX_HOPS=5` relay limit + `LINE_CAP_BYTES=64KB` per-message cap).
- Tools: `coms_list` (peers + live context-window usage), `coms_send` (ack → msg_id), `coms_get`, `coms_await`.
- Local: Unix sockets (`~/.pi/coms/projects/<project>/agents/*.json` registry). Remote: `coms-net` (HTTP+SSE hub, separate codepath).
- The live pool widget (above the editor), keepalive pings.

armory-mesh's DESIGN.md enumerates the gaps to close + the hardening on top.

## Open questions (resolve in the relevant phase)

- Hub-less cross-host: git-sync the registry, or always hub for cross-machine? (Phase 6.)
- Persistence default: opt-in per channel, or opt-out? (Phase 4 — leaning opt-in, but `fleet-state.jsonl` always persists.)
- Context-window-usage signal: how does the extension read its own session's context usage? (Phase 2 — port coms's approach.)
- `fleet-state.jsonl` field format. (Phase 5.)