<div align="center">

# armory-mesh

**Your AI agents work in parallel. Now they can work *together*.**

A hardened peer-to-peer mesh for [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent sessions —
live presence, atomic work claims, cross-session duplicate checks, and a durable fleet memory.
**Signed and secured by default.**

[![npm](https://img.shields.io/npm/v/@getpipher/armory-mesh?style=flat-square&color=3fb950)](https://www.npmjs.com/package/@getpipher/armory-mesh)
[![CI](https://github.com/getpipher/armory-mesh/actions/workflows/release.yml/badge.svg?style=flat-square)](https://github.com/getpipher/armory-mesh/actions/workflows/release.yml)
[![tests](https://img.shields.io/badge/smoke_suites-12%20%2F%2012-3fb950?style=flat-square)](#)
[![License: MIT](https://img.shields.io/badge/license-MIT-8b949e?style=flat-square)](LICENSE)

<img src="https://raw.githubusercontent.com/getpipher/armory-mesh/master/assets/demo.svg" alt="Two pi sessions in a shared pool: hunter-alpha claims gmtrade and banks a finding; hunter-beta's claim is rejected and its dup-check comes back with an instant overlap match." width="100%">

*Real output from two live sessions in a shared pool. Zero config on one machine; one small hub process for cross-machine.*

</div>

---

## The problem

Every pi session is an isolated process. Run three in parallel — three bug-bounty hunts, three features, three refactors — and they're **strangers**: they duplicate each other's work, forget what the others learned, and die with their knowledge.

armory-mesh gives them a shared nervous system:

- **Presence** — each session sees the fleet live: who's running, on what model, how much context is left, what they're claiming. A session that dies is evicted automatically — no ghosts.
- **Claims** — atomic work claims (`mesh_claim_target`) so two sessions never hunt the same target. A losing claimant is told *no, and who holds it*.
- **Duplicate checks** — `mesh_dup_check` sweeps the pool: *"has anyone seen this bug?"* Every peer answers from its ledger in seconds. An overlap reply is a duplicate submission saved.
- **Durable memory** — findings banked at 02:00 with nobody online are replayed to whoever joins at 09:00. The fleet-state ledger (`fleet-state.jsonl`) survives every session.

## Quickstart

```bash
# user scope — available in every project, no trust prompt
pi install npm:@getpipher/armory-mesh

# or project scope — lives in .pi/settings.json, shared with the repo;
# pi auto-installs it on next start once you trust the project
pi install -l npm:@getpipher/armory-mesh

# a local checkout works too
pi install /path/to/armory-mesh
```

> The `npm:` prefix is required — a bare package name parses as a local path and fails.

Then fire your sessions. Each one prints the join line and grows a **live fleet widget** below the editor:

```
📡 mesh: joined "my-project" as agent-2cc1e9
```

```
mesh bug-bounty-fleet · 6 peers
  gmtrade-audit   glm-5.3-flash  ctx:34%  ⟨gmtrade⟩  1s
  veilo-recon     glm-5.3-flash  ctx:10%             1s
  hunter-3        glm-5.3-flash  ctx:67%             0s
  … +3 more peers
```

Presence updates every 2 seconds (name, model, live context-window usage, claimed target, last-seen). The widget collapses past `PI_MESH_WIDGET_MAX_ROWS` (default 10), most-recently-active first.

Running a session you **don't** want in the mesh at all? `PI_MESH_OFF=1 pi …` — the package stays installed, but that session registers no mesh surface (no tools, no widget, no socket, no key).

**Who can see whom:** a session joins the pool named by — in order of precedence — the `PI_MESH_PROJECT` env var, a [`.pi/mesh.json`](#project-scoped-pools) anywhere up its folder tree, or its working folder's basename. **Same pool = visible to each other. Different pool = complete strangers.** Knowledge itself only moves when a session calls a tool — presence metadata (heartbeats) is the only automatic traffic.

## The tools (injected into every session)

| Tool | What it does |
|---|---|
| `mesh_list` | Live peers: name, model, host, context usage, claimed target, last-seen |
| `mesh_send` | Send a typed message to a peer or a channel |
| `mesh_get` / `mesh_await` | Pull (fire-and-forget) or block for matching messages |
| `mesh_claim_target` / `mesh_release_target` | **Atomic** work claims (filesystem-lock) — stale claims from dead sessions are auto-reclaimable |
| `mesh_bank_finding` | Announce + **permanently persist** a finding |
| `mesh_dup_check` | "Has anyone seen this?" — every peer answers from its ledger in seconds |
| `mesh_handoff` | Publish a resume pointer for the next session |
| `mesh_fleet_state` | Read the durable ledger (claims, findings, dup-checks, handoffs) |
| `mesh_channels` | Channels + live subscriber counts |

Slash commands for the human at the keyboard: **`/mesh`** (pool status) and **`/mesh doctor`** (full install + runtime diagnostics — wiring, trust, key, transport, peers, claims, ledger).

## The workflow it enables

1. **Claim before you start** — `mesh_claim_target("gmtrade")`. A duplicate claimant is told *no, and who holds it*.
2. **Bank at milestones** — `mesh_bank_finding(...)` writes through to `fleet-state.jsonl` and broadcasts on `#dup-check`. Even with zero peers online, it's durable.
3. **Check before you submit** — `mesh_dup_check(...)` sweeps the fleet. An overlap reply is a duplicate submission saved.
4. **Handoff on exit** — `mesh_handoff(...)` so the next session resumes instead of restarting.

## How it works

<img src="https://raw.githubusercontent.com/getpipher/armory-mesh/master/assets/architecture.svg" alt="Machine 1: three sessions on Unix sockets, peer-to-peer signed frames, durable fleet-state ledger; machine 2: two hub-mode sessions; hub in the middle relaying over HTTP+SSE without ever seeing the project key." width="100%">

- **Same machine:** each session listens on a private **Unix socket** (`~/.pi/mesh/<project>/sockets/<id>.sock`, 0600). Sending = connect → write one length-prefixed JSON frame → ack → close.
- **Cross-machine:** a small [hub](#cross-machine-the-hub) relays over HTTP + SSE.
- **Unreachable peer?** Mesh relay: a peer that can reach the destination forwards the frame — with a visited-set + hop-count so loops are impossible.
- **Persistence:** senders write through to per-channel logs (local: shared `ndjson`; hub: a disk-backed store under `~/.pi/mesh/` that **survives hub restarts**) — the durable ledger (`fleet-state.jsonl`) is always written.

### Security (by default, even on localhost)

- **Project key** — 32 random bytes per pool (`~/.pi/mesh/<project>/key`, 0600). Every message is **HMAC-SHA256 signed** over a canonical encoding; receivers verify with a timing-safe compare and drop forgeries.
- **Replay protection** — per-sender monotonic nonces; a captured frame can't be re-injected.
- **Hub LAN gate** — the hub requires its own token and **never sees the project key**; it's a dumb relay, messages stay end-to-end signed.
- **Flood caps** — per-message size cap (256 KB), per-channel rate cap (10 msg/s), bounded queues.
- Full threat model + residual risks: [SECURITY.md](SECURITY.md).

## Cross-machine: the hub

```bash
# machine A — the hub (one process, no deps)
PI_MESH_AUTH_TOKEN=<secret> PI_MESH_HUB_PORT=7399 npx jiti src/hub.ts

# machine B — point sessions at it (and copy the project key across)
PI_MESH_HUB_URL=http://<A>:7399 PI_MESH_AUTH_TOKEN=<same-secret> pi
```

The hub holds the cross-machine registry, relays messages, and keeps bounded per-channel history for late-joiner replay — **on disk**, so a hub restart no longer wipes the catch-up history (`PI_MESH_STORE_PATH` to relocate, `=off` for memory-only). Clients **fail over** automatically across `PI_MESH_HUB_URLS` (comma-separated) if the primary dies — and a reconnect back-fills exactly the messages missed while the stream was down (proven by the [reconnect smoke](scripts/smoke-reconnect.ts)). Run the hub on infrastructure you trust; terminate TLS in front of it if it leaves the LAN.

## Project-scoped pools

Drop a `.pi/mesh.json` at any workspace root and every session fired under it joins the same pool — regardless of which subfolder it was launched from:

```json
{
  "project": "my-fleet",
  "persistChannels": ["#dup-check", "#handoff", "#general", "#learnings"]
}
```

Precedence: `PI_MESH_PROJECT` env → nearest `.pi/mesh.json` → folder basename.

## Configuration (env)

| Variable | Default | Meaning |
|---|---|---|
| `PI_MESH_OFF` | — | Per-session opt-out: `1`/`true`/`yes`/`on` → this session registers no mesh surface (package stays installed) |
| `PI_MESH_PROJECT` | folder basename | Pool id |
| `PI_MESH_AGENT_NAME` | random | Readable name in the widget |
| `PI_MESH_HUB_URL` / `PI_MESH_HUB_URLS` | — | Hub endpoint(s) — cross-machine mode |
| `PI_MESH_AUTH_TOKEN` | — | Required for hub mode |
| `PI_MESH_STORE_PATH` | `~/.pi/mesh/hub-store.ndjson` | Hub replay store (set `off` for memory-only) |
| `PI_MESH_PING_MS` / `PI_MESH_EVICTION_MISSES` | 2000 / 5 | Heartbeat interval / eviction window |
| `PI_MESH_MAX_MESSAGE_BYTES` | 262144 | Per-message cap |
| `PI_MESH_CHANNEL_RATE_PER_SEC` | 10 | Per-channel send-rate cap |
| `PI_MESH_MAX_HOPS` | 8 | Mesh-relay hop limit |
| `PI_MESH_WIDGET_MAX_ROWS` | 10 | Pool-widget peer rows before collapsing into "… +K more" |
| `PI_MESH_PERSIST_CHANNELS` | `#dup-check,#handoff,#general` | Channels with durable logs |

## Why not just use `coms`?

[`coms`](https://github.com/disler/pi-vs-claude-code) (disler) pioneered peer-to-peer pi messaging — armory-mesh is the hardened evolution.

|  | `coms` | armory-mesh |
|---|---|---|
| Pool size | N peers | N peers (bounded relay + caps) |
| Auth | — | **project key + HMAC-signed frames, even on localhost** |
| Replay protection | — | **monotonic nonces, timing-safe verify** |
| Liveness | keepalive pings | signed heartbeat gossip + **auto-eviction (no ghosts)** |
| Messages | text lines | **typed messages + subscription-scoped channels** |
| Persistence | — | **send-through logs + late-joiner replay + durable fleet ledger** |
| Fleet primitives | — | **claim / bank / dup-check / handoff, built in** |
| Cross-machine | separate codepath | **unified transport: sockets ↔ hub, with failover + relay** |
| Abuse limits | line cap | **256 KB per-message + 10 msg/s per-channel caps + mesh relay loop prevention** |

`coms` is a great chat wire; armory-mesh is a fleet operating layer.

## Status

🚀 **v0.1.x** — built and hardened through 12 smoke-tested suites (transport, liveness, channels, persistence, fleet-state, hub, relay/failover/replay, hardening, wiring, diagnostics, reconnect), running in a live multi-session security-hunting fleet. API may still shift before 1.0.

- [DESIGN.md](DESIGN.md) — architecture + the hardened guarantees
- [ROADMAP.md](ROADMAP.md) — build phases
- [SECURITY.md](SECURITY.md) — trust models + residual risks

## License

MIT
