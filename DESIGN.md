# armory-mesh — Design

> The in-house answer to disler's `coms` — a hardened peer-to-peer mesh for pi agents. This doc is the spec the implementation sessions build against.

**Status:** scaffold (2026-08-06). The architecture is decided; the implementation is phased (see `ROADMAP.md`).

---

## 1. The problem

Pi sessions are isolated processes. There is **no native live cross-session channel** — one terminal cannot broadcast to another in real time. When you run N parallel pi sessions (e.g., N bug-bounty hunts), they are blind to each other unless they share state through a file (snapshot) or an external broker.

disler's `coms` (in `disler/pi-vs-claude-code`, `extensions/coms.ts`) added the first real answer: **peer-to-peer messaging between pi agents** over Unix sockets, same-machine, with a networked `coms-net` variant (HTTP+SSE hub) for cross-machine. It's an N-peer pool (not 2-capped; bounded by a 5-hop relay limit + 64KB per-message cap), with tools `coms_list` / `coms_send` / `coms_get` / `coms_await`.

`coms` is good. `armory-mesh` is the hardened, richer, in-house evolution.

## 2. Why not just use `coms`?

`coms` has gaps that matter for a hardened, long-running fleet (a bug-bounty fleet runs for days, across machines, with findings that must not be lost):

| `coms` gap | Why it matters | `armory-mesh` answer |
|---|---|---|
| **flat pool, no routing intelligence** | a peer can't reach a peer it can't see directly (cross-host without the hub) | **mesh routing** — peers relay to unreachable peers; hop-count + a visited-set prevent loops (coms has `MAX_HOPS=5` but no mesh routing logic) |
| **stale registry on crash** | a session that crashes leaves a dead `~/.pi/coms/projects/<project>/agents/*.json` entry → `coms_list` shows ghosts | **heartbeat + auto-eviction** — miss N pings → evicted from the registry + the pool widget |
| **two codepaths: `coms` (local) vs `coms-net` (remote)** | you pick the transport at startup; no fallback | **one unified transport** — auto: local Unix socket if same-machine, hub if remote; the tool API is identical |
| **no auth on local** (fs perms only); remote needs a token | a rogue pi session on the same machine silently joins the pool | **per-project auth token + allowlist by default** (even local); messages are **signed** with a project key; **nonce replay protection** |
| **ephemeral messaging** (gone on restart) | a finding broadcast at 02:00 is lost if a session starts at 09:00 | **optional per-channel persistence** — the durable ledger; late-joiners **replay from a cursor** on join |
| **free-text to one peer or broadcast** | no way to scope comms ("only the dup-check channel") or route by message type | **typed messages** (`finding` / `dup_check` / `scope` / `learning` / `handoff` / `heartbeat` / `claim`) + **channels/topics** (`#gmtrade`, `#dup-check`, `#learnings`) |
| **per-machine registry** | a peer on machine B can't discover peers on machine A without the hub | **cross-host shared registry** (hub-held, or git-synced for the hub-less local mode) |
| **generic messaging only** | you build the fleet-state ops (claim/bank/dup-check) yourself every time | **fleet-state primitives baked in**: `mesh_claim_target`, `mesh_bank_finding`, `mesh_dup_check`, `mesh_handoff` — typed, persisted, the durable layer |
| **no message auth** | a rogue peer could spoof a `finding` or a `claim` | **signed messages** (HMAC over the project key) + **nonce replay protection** |

## 3. The architecture

```
┌─────────────────────────────────────────────────────────────┐
│  pi session A (pi -e extensions/mesh.ts)                     │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐     │
│  │  mesh tools  │──▶│  channels    │──▶│ persistence  │     │
│  │ (the API)    │   │ (typed msgs) │   │ (durable log) │     │
│  └──────┬───────┘   └──────────────┘   └──────┬───────┘     │
│         │                                       │            │
│  ┌──────▼───────┐                       ┌───────▼──────┐      │
│  │   auth       │                       │   registry    │      │
│  │ (sign/verify)│                       │ (peers+state) │      │
│  └──────┬───────┘                       └───────┬──────┘      │
│         │                                       │            │
│  ┌──────▼───────────────────────────────────────▼──────┐    │
│  │              transport (unified)                     │    │
│  │  local: Unix socket  ←auto→  remote: HTTP/SSE hub    │    │
│  └──────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────┘
                             │  (mesh: peers relay to unreachable peers)
        ┌────────────────────┴────────────────────┐
        ▼                                         ▼
  pi session B                               pi session C (other host → hub)
```

### 3.1 Transport (unified, local-first)
- **Local (same machine):** Unix domain socket per agent (`~/.pi/mesh/<project>/sockets/<agent-id>.sock`); Windows: named pipe. No server — agents listen directly.
- **Remote (cross-machine):** a small HTTP+SSE hub (`src/hub.ts`, runnable standalone or via `pi -e extensions/mesh.ts --hub`) relays messages + holds the shared registry. LAN mode requires `PI_MESH_AUTH_TOKEN`.
- **Auto-selection:** each agent probes whether a peer is on the same machine (registry field); if yes → Unix socket, if no → hub. The tool API (`mesh_send`, etc.) is identical either way. One codepath, not two.
- **Mesh relay:** if agent A can't reach agent C directly (different machine, no hub), and agent B can reach both, B relays (with a visited-set + hop-count to prevent loops). This is the "mesh" beyond coms's "pool."

### 3.2 Registry (cross-host, liveness-aware)
- **Local mode:** file registry at `~/.pi/mesh/<project>/agents/<agent-id>.json` (name, model, host, socket path, last-heartbeat, context-window-usage). Git-syncable for cross-host discovery in hub-less mode.
- **Hub mode:** the hub holds the live registry; agents fetch on join + on heartbeat.
- **Liveness:** each agent pings every `PI_MESH_PING_MS` (default 2000); a peer that misses `PI_MESH_EVICTION_MISSES` (default 5) pings is evicted (dead-entry cleanup — the coms stale-registry gap closed).
- **`mesh_list`** returns the live peers: name, model, host, **context-window usage** (the live-awareness primitive), last-seen, claimed-target (if any).

### 3.3 Auth (by default, even local)
- **Per-project key:** `~/.pi/mesh/<project>/key` (generated on first join, 32-byte secret). Shared out-of-band to peers you want in the pool (the "invite").
- **Allowlist:** `~/.pi/mesh/<project>/allowlist.json` — agent-ids permitted to join. A rogue pi session without the key + allowlist entry can't join.
- **Signed messages:** every message carries an HMAC-SHA256 over `{project, from, channel, type, nonce, payload}` using the project key. Receivers verify; drop on mismatch.
- **Replay protection:** per-sender monotonic nonce; receivers reject a nonce ≤ the last-seen for that sender.
- **Hub mode:** the hub also requires `PI_MESH_AUTH_TOKEN` (LAN) so a remote rogue can't inject.

### 3.4 Channels + typed messages
- **Channels** (topics): scoped comms. Default channels per project: `#general`, `#dup-check`, `#learnings`, `#handoff`, `#heartbeats`. Plus per-target channels (e.g., `#gmtrade`, `#veilo`) created on demand. `mesh_send(channel="#dup-check", ...)`.
- **Typed messages** (the `type` field, validated):
  - `heartbeat` — liveness ping (auto, not user-facing)
  - `claim` — a session claims a target (`mesh_claim_target`)
  - `release` — release a claimed target
  - `finding` — bank a finding (`mesh_bank_finding`)
  - `dup_check` — request a cross-hunt dup-check (`mesh_dup_check`)
  - `dup_check_result` — the response
  - `scope` — share a scope/pre-bunk
  - `learning` — share a rextor `00-LEARNINGS.md`-style pitfall
  - `handoff` — a session-handoff pointer (`mesh_handoff`)
  - `text` — free-form (the coms-style escape hatch)
- Routing: `mesh_send` to a channel (all subscribers) OR a specific peer. `mesh_get` filters by channel + type. `mesh_await` blocks for a typed reply (e.g., await a `dup_check_result`).

### 3.5 Persistence + late-joiner replay (the durable ledger)
- **Optional** per-channel message log: `~/.pi/mesh/<project>/logs/<channel>.ndjson` (append-only, newline-delimited JSON, rotated by size). Enabled per-channel via config.
- **Cursor-based replay:** on join, a peer sends its last-seen cursor per channel; the hub (or the log-holding peer in local mode) replays from there. A session that starts at 09:00 catches up on the 02:00 `finding` broadcast.
- **Fleet-state write-through:** `mesh_claim_target` / `mesh_bank_finding` / `mesh_handoff` always persist to a `fleet-state.jsonl` (the durable ledger) — even if ephemeral messaging is on, fleet state is never lost. This is the persisted `HUNT-FLEET.md` layer, but structured + typed.

### 3.6 Fleet-state primitives (the "rich" layer)
Baked-in, typed, persisted ops on top of the generic mesh (so bug-bounty fleets — or any fleet — don't rebuild them):
- `mesh_claim_target(target, scope)` — atomically claim a target for this session; other sessions see it via `mesh_list` (the `claimed-target` field) + a `claim` message on `#general`. Prevents two sessions hunting the same target.
- `mesh_release_target(target)` — release (on exit or handoff).
- `mesh_bank_finding(target, severity, title, ref)` — announce a banked finding on `#dup-check`; persists to `fleet-state.jsonl`. Other sessions' `mesh_dup_check` queries match against these.
- `mesh_dup_check(target, finding-title, root-cause)` — broadcast a dup-check request on `#dup-check`; `mesh_await` collects the peers' `dup_check_result` responses (cross-hunt dup-check — the killer feature for parallel bug-bounty).
- `mesh_handoff(target, handoff-path)` — announce a session-handoff pointer on `#handoff`; persists so the next session + the peers know where to resume.

## 4. The tool API (the pi extension surface)

The extension injects these tools into each pi session that loads it:

| Tool | Signature (sketch) | Purpose |
|---|---|---|
| `mesh_list` | `() → Peer[]` | list live peers (name, model, host, context-usage, claimed-target, last-seen) |
| `mesh_send` | `(target?: id, channel?: string, type?: MsgType, payload: any) → msgId` | send a typed message to a peer or a channel |
| `mesh_get` | `(channel?: string, type?: MsgType, since?: cursor) → Msg[]` | pull messages (filtered) |
| `mesh_await` | `(predicate, timeoutMs) → Msg` | await a matching message (e.g., a `dup_check_result`) |
| `mesh_claim_target` | `(target: string, scope?: string) → boolean` | atomically claim a hunt target |
| `mesh_release_target` | `(target: string) → void` | release a claim |
| `mesh_bank_finding` | `(target, severity, title, ref) → void` | announce + persist a finding |
| `mesh_dup_check` | `(target, title, rootCause) → DupCheckResult[]` | cross-hunt dup-check (awaits peer responses) |
| `mesh_handoff` | `(target, handoffPath) → void` | announce a handoff pointer |
| `mesh_fleet_state` | `() → FleetState` | read the durable ledger (all claims, findings, handoffs) |
| `mesh_channels` | `() → Channel[]` | list channels + subscriber counts |

Plus a live **pool widget** (like coms) above the editor: the peers + their context usage + claimed targets, refreshing on heartbeat.

## 5. The hardened guarantees (the "more hardened" claim)

1. **Auth by default** — no peer joins without the project key + allowlist, even on localhost.
2. **Signed + replay-protected** — every message HMAC'd; nonces monotonic per sender.
3. **Liveness + auto-eviction** — dead peers evicted, no ghosts.
4. **Fleet state is never lost** — claims/findings/handoffs write-through to `fleet-state.jsonl` even if messaging is ephemeral.
5. **Mesh relay with loop-prevention** — a peer can't be spammed into an infinite relay loop (visited-set + hop-count).
6. **Per-message size cap** (default 256KB, configurable) + **per-channel rate cap** (default 10 msg/s) — a noisy peer can't drown the pool.
7. **Hub failover** (hub mode): the hub is the one SPOF; a second hub can run in standby + clients fail over. (Phase 2; Phase 1 is single-hub.)
8. **Observability hooks** — emits `ObsEvent`s compatible with `disler/pi-agent-observability` so mesh traffic is visible in the swimlane/race UI.

## 6. Scope + non-goals (this scaffold)

**In scope (the scaffold):** the architecture (this doc) + the build phases (`ROADMAP.md`) + the repo/package structure + the tool-signature stubs (`extensions/mesh.ts`, `src/`). The implementation is phased.

**Non-goals:**
- Not an orchestrator (that's `armory-fleet`). armory-mesh is flat peer-to-peer; no parent/child.
- Not a replacement for `armory-todo` / `armory-memory` (those are state stores). armory-mesh is the live transport + the fleet-state ledger; it complements them.
- Not cross-org (the project key scopes a pool to one project/team). Multi-org federation is a later phase.

## 7. Dogfooding plan

1. Build Phase 1 (local Unix-socket transport + registry + liveness + `mesh_list`/`mesh_send`/`mesh_get`/`mesh_await`) — the coms parity.
2. Smoke-test: two `pi -e extensions/mesh.ts` sessions, same machine, confirm `mesh_list` sees both + a `mesh_send` round-trips + a killed session is evicted.
3. Dogfood in the bug-bounty fleet: the parallel hunt sessions (GMTrade + others) load `mesh.ts`, claim their targets via `mesh_claim_target`, do cross-hunt `mesh_dup_check` before submitting, share `mesh_bank_finding` + `mesh_handoff`.
4. Iterate via `refining`-style passes (the dogfooding feedback loop). Graduate to public + npm-publish when stable.

## 8. Open questions (for the build sessions)

- **Hub-less cross-host:** is git-syncing the registry enough, or do we always want the hub for cross-machine? (Leaning: hub for cross-machine; git-sync is a fallback for air-gapped.)
- **Persistence default:** opt-in (channels persist only if configured) or opt-out (all channels persist by default)? (Leaning: opt-in, but `fleet-state.jsonl` always persists.)
- **Context-window usage signal:** how does the extension read its own session's context usage to broadcast it? (coms does this — port the approach.)
- **The `fleet-state.jsonl` format:** ndjson with what fields? (Define in Phase 3 with the fleet-state primitives.)