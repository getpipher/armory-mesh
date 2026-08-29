# armory-mesh

> **Your AI agents work in parallel. Now they can work *together*.**
> A hardened peer-to-peer mesh for [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent sessions — live presence, work claims, cross-session duplicate checks, and a durable fleet memory. Signed and secured by default.

`@getpipher/armory-mesh` is a pi extension that lets N parallel pi sessions talk to each other **peer-to-peer** — equal agents, no orchestrator — across folders on one machine, or across machines over a hub.

---

## The problem

Every pi session is an isolated process. Run three in parallel — three bug-bounty hunts, three features, three refactors — and they're **strangers**: they duplicate each other's work, forget what the others learned, and die with their knowledge.

## The 30-second demo

Open two terminals in two project folders that share a mesh pool.

- **Session A** claims a target and banks a finding.
- **Session B** (started later) tries to claim the same target → *"taken — held by session A."*
- B then asks the pool: *"has anyone seen this bug?"* → A answers instantly: **"yes — I banked that exact finding."**

Zero config on one machine. One small hub process for cross-machine.

## Install

```bash
# in the project where your sessions run
pi install @getpipher/armory-mesh        # npm package, or
pi install ~/path/to/armory-mesh         # a local checkout
```

Then fire your sessions. On startup each one prints:

```
📡 mesh: joined "my-project" as agent-2cc1e9
```

… and shows a **live fleet widget** below the editor:

```
mesh bug-bounty-fleet · 6 peers
  gmtrade-audit   glm-5.3-flash  ctx:34%  ⟨gmtrade⟩  1s
  veilo-recon     glm-5.3-flash  ctx:10%             1s
  hunter-3        glm-5.3-flash  ctx:67%             0s
  ...
```

Presence updates every 2 seconds (name, model, live context-window usage, claimed target). A session that dies is evicted automatically — no ghosts.

### Pools (who can see whom)

A session joins the pool named by — in order of precedence — the `PI_MESH_PROJECT` env var, a [`.pi/mesh.json`](#project-scoped-pools) anywhere up its folder tree, or its working folder's basename. **Same pool = visible to each other. Different pool = complete strangers.** Knowledge itself only moves when a session calls a tool — presence metadata (heartbeats) is the only automatic traffic.

## The tools (injected into every session)

| Tool | What it does |
|---|---|
| `mesh_list` | Live peers: name, model, host, context usage, claimed target, last-seen |
| `mesh_send` | Send a typed message to a peer or a channel |
| `mesh_get` / `mesh_await` | Pull (fire-and-forget) or block for matching messages |
| `mesh_claim_target` / `mesh_release_target` | **Atomic** work claims (filesystem-lock) — prevents two sessions doing the same job. Stale claims from dead sessions are auto-reclaimable |
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

A finding banked at 02:00 with nobody online is replayed to whoever joins at 09:00 — the durable ledger is the point.

## How it works

```
session A (mailbox: sockets/A.sock)     session B (mailbox: sockets/B.sock)
        │                                        │
        │ ① signed HEARTBEAT every 2s            │
        │   (liveness, ctx %, claims, channels)  │
        ├─────────→ to every known peer ─────────┤     → fills the widget
        │                                        │
        │ ② tool calls only (mesh_send, …):      │
        ├───── one signed frame per recipient ──→│  B verifies signature → queues
```

- **Same machine:** each session listens on a private **Unix socket** (`~/.pi/mesh/<project>/sockets/<id>.sock`, 0600). Sending = connect → write one length-prefixed JSON frame → ack → close.
- **Cross-machine:** a small [hub](#cross-machine-the-hub) relays over HTTP + SSE.
- **Unreachable peer?** Mesh relay: a peer that can reach the destination forwards the frame — with a visited-set + hop-count so loops are impossible.
- **Persistence:** senders write through to per-channel logs (local: shared `ndjson`; hub: in-memory bounded store) — the durable ledger (`fleet-state.jsonl`) is always written.

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

The hub holds the cross-machine registry, relays messages, and keeps bounded per-channel history for late-joiner replay. Clients **fail over** automatically across `PI_MESH_HUB_URLS` (comma-separated) if the primary dies. Run the hub on infrastructure you trust; terminate TLS in front of it if it leaves the LAN.

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
| `PI_MESH_PROJECT` | folder basename | Pool id |
| `PI_MESH_AGENT_NAME` | random | Readable name in the widget |
| `PI_MESH_HUB_URL` / `PI_MESH_HUB_URLS` | — | Hub endpoint(s) — cross-machine mode |
| `PI_MESH_AUTH_TOKEN` | — | Required for hub mode |
| `PI_MESH_PING_MS` / `PI_MESH_EVICTION_MISSES` | 2000 / 5 | Heartbeat interval / eviction window |
| `PI_MESH_MAX_MESSAGE_BYTES` | 262144 | Per-message cap |
| `PI_MESH_CHANNEL_RATE_PER_SEC` | 10 | Per-channel send-rate cap |
| `PI_MESH_MAX_HOPS` | 8 | Mesh-relay hop limit |
| `PI_MESH_WIDGET_MAX_ROWS` | 10 | Pool-widget peer rows before collapsing into "… +K more" |
| `PI_MESH_PERSIST_CHANNELS` | `#dup-check,#handoff,#general` | Channels with durable logs |

## Why not just use `coms`?

[`coms`](https://github.com/disler/pi-vs-claude-code) (disler) pioneered peer-to-peer pi messaging — armory-mesh is the hardened evolution: auth + signed messages + replay protection by default (even local), liveness + auto-eviction (no ghost peers), typed messages + subscription-scoped channels, durable send-through persistence with late-joiner replay, fleet-state primitives baked in (claim / bank / dup-check / handoff), mesh relay with loop prevention, hub failover, and per-message + per-channel flood caps. `coms` is a great chat wire; armory-mesh is a fleet operating layer.

## Status

🚧 **Dogfooding** — built and hardened through 8 phases of smoke-tested development (transport, liveness, channels, persistence, fleet-state, hub, relay/failover/replay, hardening), currently running in a live multi-session security-hunting fleet. API may still shift before 1.0.

- [DESIGN.md](DESIGN.md) — architecture + the hardened guarantees
- [ROADMAP.md](ROADMAP.md) — build phases
- [SECURITY.md](SECURITY.md) — trust models + residual risks

## License

MIT
