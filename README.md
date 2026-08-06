# armory-mesh

> **Hardened peer-to-peer mesh for pi agents** — the in-house answer to disler's [`coms`](https://github.com/disler/pi-vs-claude-code). N-peer mesh with unified transport, liveness + auto-eviction, built-in auth, typed messages + channels, optional persistence + late-joiner replay, and fleet-state primitives.

`@getpipher/armory-mesh` is a pi extension (loadable via `pi -e extensions/mesh.ts` or the `packages` array in `.pi/settings.json`) that lets N parallel pi sessions talk to each other **peer-to-peer** — equal agents, no orchestrator — so a fleet of hunts (or any parallel work) is **mutually aware in real time**.

**Status:** 🚧 scaffold (2026-08-06). Architecture decided ([`DESIGN.md`](DESIGN.md)); build phased ([`ROADMAP.md`](ROADMAP.md)). Not yet dogfooded.

---

## Why

Pi sessions are isolated processes — there's no native live cross-session channel. When you run N parallel pi sessions (N bug-bounty hunts, N features), they're blind to each other unless they share a file (snapshot) or a broker.

`coms` (disler, in `pi-vs-claude-code`) added the first real answer: peer-to-peer messaging over Unix sockets, with a networked `coms-net` variant. It's an N-peer pool (not 2-capped) with `coms_list` / `coms_send` / `coms_get` / `coms_await`.

`armory-mesh` is the hardened, richer, in-house evolution — built to be dogfooded in the getpipher bug-bounty fleet, then published.

## How it beats `coms`

| | `coms` | `armory-mesh` |
|---|---|---|
| Topology | flat pool | **mesh** (peers relay to unreachable peers; hop-count + loop-prevention) |
| Dead peers | stale registry on crash | **heartbeat + auto-eviction** |
| Transport | local (`coms`) vs remote (`coms-net`) — two codepaths | **one unified transport** (auto: local Unix socket ↔ remote hub) |
| Auth (local) | filesystem perms only | **project key + allowlist + signed messages + nonce replay protection** |
| Messages | ephemeral (gone on restart) | **optional per-channel persistence + late-joiner replay** |
| Message shape | free-text | **typed** (`finding` / `dup_check` / `scope` / `learning` / `handoff` / `claim` / `heartbeat`) + **channels** |
| Registry | per-machine | **cross-host shared** (hub-held or git-synced) |
| Fleet ops | generic messaging — you build claim/bank/dup-check yourself | **fleet-state primitives baked in**: `mesh_claim_target`, `mesh_bank_finding`, `mesh_dup_check`, `mesh_handoff` |
| Fleet state loss | ephemeral | **never lost** — claims/findings/handoffs write-through to `fleet-state.jsonl` |

See [`DESIGN.md`](DESIGN.md) for the full architecture + the tool API + the hardened guarantees.

## The tools (the pi extension surface)

| Tool | Purpose |
|---|---|
| `mesh_list` | list live peers — name, model, host, **context-window usage**, claimed-target, last-seen |
| `mesh_send` | send a typed message to a peer or a channel |
| `mesh_get` | pull messages (filtered by channel/type) |
| `mesh_await` | await a matching message (e.g., a `dup_check_result`) |
| `mesh_claim_target` | atomically claim a hunt target for this session |
| `mesh_release_target` | release a claim |
| `mesh_bank_finding` | announce + persist a finding |
| `mesh_dup_check` | cross-hunt dup-check (broadcasts + awaits peer responses) |
| `mesh_handoff` | announce a session-handoff pointer |
| `mesh_fleet_state` | read the durable ledger (all claims, findings, handoffs) |
| `mesh_channels` | list channels + subscriber counts |

Plus a live **pool widget** above the editor (the peers + their context usage + claimed targets, refreshing on heartbeat).

## Install (when implemented)

```bash
# as a pi package (the getpipher convention) — add to your project .pi/settings.json:
{
  "packages": ["@getpipher/armory-mesh"]
}
# or load directly per-session:
pi -e extensions/mesh.ts
# the hub (cross-machine):
bun src/hub.ts            # local hub (127.0.0.1)
PI_MESH_AUTH_TOKEN=... bun src/hub.ts --lan   # LAN-visible hub
```

## The bug-bounty fleet use case (the dogfood)

Parallel bug-bounty hunts, each in its own pi terminal, each loading `mesh.ts`:
1. At startup: `mesh_fleet_state` → see what the other sessions claimed. `mesh_claim_target("gmtrade")` → atomically claim; the others see it via `mesh_list`.
2. Before banking a finding: `mesh_dup_check("gmtrade", "perp param substitution", "relayer params not bound")` → the other sessions respond with overlap/no-overlap → **live cross-hunt dup-check**.
3. On banking: `mesh_bank_finding("gmtrade", "HIGH", "jperp param substitution", ref)` → announced on `#dup-check` + persisted to `fleet-state.jsonl`.
4. On handoff: `mesh_handoff("gmtrade", "/path/to/handoff.md")` → the peers + the next session know where to resume.

The durable `fleet-state.jsonl` is the persisted `HUNT-FLEET.md` layer — but structured, typed, and live-coordinated instead of a snapshot file.

## Status + roadmap

🚧 **scaffold** — Phase 0 done (this session). Phase 1 (coms parity: local transport + the 4 core tools) is next. Full build plan in [`ROADMAP.md`](ROADMAP.md). Dogfooding in the bug-bounty fleet is the graduation gate (Phase 8), then publish (Phase 9).

## License

MIT — matches the `@getpipher/armory-*` family. Private repo initially (in-house dogfooding); flips to public on publish (Phase 9).

## Seeded from

disler's `coms` (`disler/pi-vs-claude-code`, `extensions/coms.ts`) — the peer-to-peer-agent-comms pattern. Hardened + extended for the getpipher fleet use case. The coms design + the `pi-agent-observability` ObsEvent pattern are the reference points.