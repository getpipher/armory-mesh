// armory-mesh — the remote hub (HTTP+SSE relay + shared registry).
// See DESIGN.md §3.1/§3.2 + ROADMAP.md Phase 6.
//
// A small standalone server (Node `http`, no deps) that lets pi agents on different machines
// discover each other + exchange signed messages. LAN mode requires PI_MESH_AUTH_TOKEN (auth by
// default — a rogue on the LAN can't inject or sniff). The hub holds the live registry (peers
// across machines) + relays messages over SSE. Messages are still signed by the project key — the
// hub is a dumb relay; peers verify on receive.
//
// Run: `node --import <jiti>/lib/jiti-register.mjs src/hub.ts`
//   env: PI_MESH_HUB_PORT (default 7373), PI_MESH_AUTH_TOKEN (required),
//        PI_MESH_PING_MS (default 2000), PI_MESH_EVICTION_MISSES (default 5).
//
// Endpoints (all require header `X-Mesh-Token: <token>`):
//   GET  /events?agentId=<id>   — SSE stream: {type:"frame"|"peer-joined"|"peer-left"|"peer-updated", ...}
//   POST /join      {agentId, peer}            — register; hub broadcasts peer-joined; returns {peers}
//   POST /leave     {agentId}                 — deregister; hub broadcasts peer-left
//   POST /heartbeat {agentId, contextUsage?, channels?, claimedTarget?} — update + broadcast peer-updated
//   POST /send      {frame}                   — relay: targeted (msg.to) or broadcast (msg.channel)
//
// Phase 6.5 (deferred): mesh relay (hub-less cross-machine) + hub failover (standby hub).

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Peer, Frame, MeshMsg } from "./index.js";
import { DEFAULT_CHANNELS, isDefaultChannel } from "./channels.js";
import { MESH_ROOT } from "./paths.js";

export interface HubServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number; // the actual bound port (after start)
  /** Destroy every open client connection (SSE streams + in-flight POSTs) without stopping the
   *  hub. Clients see the streams drop + reconnect with their live cursors — the simulated
   *  network-partition for reconnect/gap tests, and an ops lever for draining connections. */
  closeConnections(): void;
}

interface HubPeer {
  peer: Peer;
  res: http.ServerResponse | null; // the SSE stream (null if not connected)
  lastSeen: number;
  // Phase 6.5: the join-time cursors this peer requested (per-channel last-seen ts). Replay is
  // flushed once over the SSE stream when it connects (or immediately if already connected).
  cursors?: Record<string, number>;
  replayed?: boolean;
}

export interface HubOpts {
  port?: number;
  authToken: string; // required (auth-by-default)
  pingMs?: number;
  evictionMisses?: number;
  // Phase 6.5: hub-stored channel logs for cross-machine late-joiner replay. Messages on these
  // channels are kept in a bounded buffer + replayed to a joining peer from its cursor.
  persistChannels?: string[];
  maxChannelLogEntries?: number; // per-channel in-memory cap (default 1000; oldest dropped on overflow)
  // Phase 10: disk-backed store — the buffer is flushed as ndjson so late-joiner replay SURVIVES a
  // hub restart (in-memory history was wiped on restart). Default <MESH_ROOT>/hub-store.ndjson
  // (0600); set PI_MESH_STORE_PATH=off (or storePath:"off") to run memory-only.
  storePath?: string;
  maxStoreBytes?: number; // file-size trigger for compaction (default 16 MB) — file is rewritten from the live buffers
}

function safeCompare(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function sseWrite(res: http.ServerResponse, payload: unknown): void {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // client gone — ignore
  }
}

export function createHubServer(opts: HubOpts): HubServer {
  const port = opts.port ?? (Number(process.env.PI_MESH_HUB_PORT) || 7373);
  const authToken = opts.authToken;
  const pingMs = opts.pingMs ?? (Number(process.env.PI_MESH_PING_MS) || 2000);
  const evictionMisses = opts.evictionMisses ?? (Number(process.env.PI_MESH_EVICTION_MISSES) || 5);
  if (!authToken) throw new Error("hub: PI_MESH_AUTH_TOKEN is required (auth-by-default).");

  const peers = new Map<string, HubPeer>();
  let server: http.Server | null = null;
  let actualPort = port;
  let evictionTimer: NodeJS.Timeout | null = null;
  // Phase 6.5: the cross-machine durable store — an in-memory bounded buffer per persisted channel.
  // The hub is the cross-machine rendezvous (local mode uses the shared filesystem log instead).
  // Messages are still signed end-to-end; the hub stores opaque signed payloads (it already sees
  // them in transit, so storing adds no exposure). Bounded to prevent unbounded memory growth.
  const persistChannels = opts.persistChannels ?? ["#general", "#dup-check", "#handoff", "#learnings"];
  const maxChannelLogEntries = opts.maxChannelLogEntries ?? 1000;
  const channelLogs = new Map<string, MeshMsg[]>();

  // ── Phase 10: disk-backed store — the buffer survives hub restarts ──
  // One ndjson append-only file (one MeshMsg per line, 0600). Loaded on start(); appends are async
  // fire-and-forget (a full disk must not stall the relay); when the file crosses maxStoreBytes it
  // is compacted by rewriting the live per-channel buffers (the buffer stays the source of truth).
  const rawStorePath = opts.storePath ?? process.env.PI_MESH_STORE_PATH;
  const storeDisabled = rawStorePath === "off" || rawStorePath === "none";
  const storePath = !storeDisabled && rawStorePath ? rawStorePath : path.join(MESH_ROOT, "hub-store.ndjson");
  const maxStoreBytes = opts.maxStoreBytes ?? 16 * 1024 * 1024;
  let storeBytes = 0;
  let compacting = false;

  /** Hydrate the per-channel buffers from the store file (called once in start(), before listen). */
  async function loadStore(): Promise<void> {
    if (storeDisabled) return;
    let raw: string;
    try { raw = await fs.promises.readFile(storePath, "utf-8"); } catch { return; } // no file yet — fresh store
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as MeshMsg;
        if (!msg || typeof msg.id !== "string" || typeof msg.channel !== "string" || !persistChannels.includes(msg.channel)) continue;
        const buf = channelLogs.get(msg.channel) ?? [];
        buf.push(msg);
        if (buf.length > maxChannelLogEntries) buf.splice(0, buf.length - maxChannelLogEntries);
        channelLogs.set(msg.channel, buf);
      } catch { /* corrupt line — skip (a torn final write must not poison the store) */ }
    }
    try { storeBytes = (await fs.promises.stat(storePath)).size; } catch { storeBytes = 0; }
  }

  function appendStore(msg: MeshMsg): void {
    if (storeDisabled) return;
    const line = JSON.stringify(msg) + "\n";
    storeBytes += Buffer.byteLength(line);
    fs.promises.appendFile(storePath, line, { mode: 0o600 })
      .catch((err) => console.error(`hub: store append failed (${(err as Error).message})`))
      .finally(() => { if (storeBytes > maxStoreBytes && !compacting) void compactStore(); });
  }

  /** Rewrite the store file from the live per-channel buffers (drops evicted/duplicate history). */
  async function compactStore(): Promise<void> {
    compacting = true;
    try {
      const lines: string[] = [];
      for (const buf of channelLogs.values()) for (const m of buf) lines.push(JSON.stringify(m));
      const body = lines.length > 0 ? lines.join("\n") + "\n" : "";
      await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
      await fs.promises.writeFile(storePath, body, { mode: 0o600, encoding: "utf-8" });
      storeBytes = Buffer.byteLength(body);
    } catch (err) {
      console.error(`hub: store compaction failed (${err instanceof Error ? err.message : String(err)})`);
    } finally {
      compacting = false;
    }
  }

  /** Store a persisted-channel message in the bounded buffer + the disk-backed store. */
  function storeMsg(msg: MeshMsg): void {
    const ch = msg.channel;
    if (!ch || !persistChannels.includes(ch)) return;
    const buf = channelLogs.get(ch) ?? [];
    buf.push(msg);
    if (buf.length > maxChannelLogEntries) buf.splice(0, buf.length - maxChannelLogEntries);
    channelLogs.set(ch, buf);
    appendStore(msg);
  }

  /** Flush replayed history to a joining peer over its SSE stream, from its requested cursors. */
  function flushReplay(hp: HubPeer): void {
    if (process.env.PI_MESH_DEBUG_TRACE) fs.appendFileSync(process.env.PI_MESH_DEBUG_TRACE, `${Date.now()} HUB flushReplay peer=${hp.peer.id.slice(0, 8)} replayed=${hp.replayed} res=${!!hp.res} cursors=${JSON.stringify(hp.cursors ?? null)} stored=${[...channelLogs.entries()].map(([c, b]) => `${c}:${b.length}`).join(",")}\n`);
    if (hp.replayed || !hp.res) return;
    hp.replayed = true;
    const cursors = hp.cursors ?? {};
    for (const ch of persistChannels) {
      const buf = channelLogs.get(ch);
      if (!buf || buf.length === 0) continue;
      const sinceTs = cursors[ch] ?? -Infinity;
      const msgs = buf.filter((m) => m.ts > sinceTs);
      if (msgs.length > 0) sseWrite(hp.res, { type: "replay", channel: ch, msgs });
    }
  }

  function broadcast(payload: unknown, except?: string): void {
    for (const [id, hp] of peers) {
      if (id === except || !hp.res) continue;
      sseWrite(hp.res, payload);
    }
  }

  function authorized(req: http.IncomingMessage): boolean {
    const tok = req.headers["x-mesh-token"];
    const t = Array.isArray(tok) ? tok[0] : tok;
    return typeof t === "string" && safeCompare(t, authToken);
  }

  function readJson(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); } catch (e) { reject(e); }
      });
      req.on("error", reject);
    });
  }

  function relayFrame(frame: Frame): void {
    const msg = frame.msg;
    if (!msg) return;
    // Phase 6.5: store persisted-channel messages for cross-machine late-joiner replay. The hub
    // is the cross-machine durable store (local mode uses the shared filesystem log instead). A
    // relayed frame still carries a real message — store on content, not on transport metadata.
    storeMsg(msg);
    if (msg.to) {
      const hp = peers.get(msg.to);
      if (hp?.res) sseWrite(hp.res, { type: "frame", frame });
      return;
    }
    const channel = msg.channel ?? "#general";
    for (const [id, hp] of peers) {
      if (id === msg.from || !hp.res) continue;
      if (isDefaultChannel(channel) || (hp.peer.channels ?? []).includes(channel)) {
        sseWrite(hp.res, { type: "frame", frame });
      }
    }
  }

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    // Auth gate (every endpoint).
    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const url = new URL(req.url ?? "", `http://localhost`);
    try {
      if (req.method === "GET" && url.pathname === "/events") {
        const agentId = url.searchParams.get("agentId") ?? "";
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // Seed the new connection with the current peer list.
        sseWrite(res, { type: "peers", peers: [...peers.values()].map((hp) => hp.peer) });
        const hp = peers.get(agentId);
        if (hp) hp.res = res;
        else {
          // First sight of this peer: seed cursors from the /events query. If /events wins the race
          // against /join (CI-caught on the v0.1.1 tag: first join, fresh HubPeer had no cursors),
          // the flushReplay below would run UNFILTERED and a peer with a forward cursor would
          // receive the full channel history. Existing peers keep their cursors — /join owns them.
          let cursors: Record<string, number> | undefined;
          const raw = url.searchParams.get("cursors");
          if (raw) { try { const p = JSON.parse(raw) as unknown; if (p && typeof p === "object" && !Array.isArray(p)) cursors = p as Record<string, number>; } catch { /* malformed — treat as absent */ } }
          peers.set(agentId, { peer: { id: agentId, name: agentId, model: "", host: "", lastSeen: Date.now(), alive: true }, res, lastSeen: Date.now(), cursors });
        }
        // Phase 6.5: flush cross-machine replay history if this peer already /join'd with cursors.
        flushReplay(peers.get(agentId)!);
        req.on("close", () => {
          const cur = peers.get(agentId);
          if (cur && cur.res === res) cur.res = null;
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/join") {
        const body = (await readJson(req)) as { agentId?: string; peer?: Peer; cursors?: Record<string, number> };
        if (!body.peer || !body.agentId) { res.writeHead(400); res.end("{}"); return; }
        const hp = peers.get(body.agentId);
        if (hp) { hp.peer = body.peer; hp.lastSeen = Date.now(); hp.cursors = body.cursors; hp.replayed = false; }
        else if (process.env.PI_MESH_DEBUG_TRACE) fs.appendFileSync(process.env.PI_MESH_DEBUG_TRACE, `${Date.now()} HUB /join UNKNOWN peer=${body.agentId.slice(0, 8)} cursors=${JSON.stringify(body.cursors ?? null)}\n`);
        else peers.set(body.agentId, { peer: body.peer, res: null, lastSeen: Date.now(), cursors: body.cursors });
        broadcast({ type: "peer-joined", peer: body.peer }, body.agentId);
        // Phase 6.5/7: flush cross-machine replay if the SSE stream is already connected (join after
        // events). If SSE isn't connected yet, flushReplay is deferred to the /events handler.
        // Phase 7: /join RESETS the replayed flag, so a reconnect re-flushes from the (live) cursors
        // — back-filling the disconnect gap instead of silently skipping it.
        flushReplay(peers.get(body.agentId)!);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ peers: [...peers.values()].map((p) => p.peer) }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/leave") {
        const body = (await readJson(req)) as { agentId?: string };
        if (body.agentId && peers.delete(body.agentId)) broadcast({ type: "peer-left", peer: { id: body.agentId, name: "", model: "", host: "", lastSeen: 0, alive: false } });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "POST" && url.pathname === "/heartbeat") {
        const body = (await readJson(req)) as { agentId?: string; contextUsage?: number; channels?: string[]; claimedTarget?: string };
        const hp = body.agentId ? peers.get(body.agentId) : undefined;
        if (hp && body.agentId) {
          hp.lastSeen = Date.now();
          if (body.contextUsage !== undefined) hp.peer.contextUsage = body.contextUsage;
          if (body.channels !== undefined) hp.peer.channels = body.channels;
          if (body.claimedTarget !== undefined) hp.peer.claimedTarget = body.claimedTarget;
          broadcast({ type: "peer-updated", peer: hp.peer }, body.agentId);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (req.method === "POST" && url.pathname === "/send") {
        const body = (await readJson(req)) as { frame?: Frame };
        if (body.frame) relayFrame(body.frame);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    } catch (err) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : "bad request" }));
    }
  };

  function evictStale(): void {
    const now = Date.now();
    const staleAfter = pingMs * evictionMisses;
    for (const [id, hp] of peers) {
      if (now - hp.lastSeen > staleAfter) {
        peers.delete(id);
        broadcast({ type: "peer-left", peer: { id, name: hp.peer.name, model: "", host: "", lastSeen: hp.lastSeen, alive: false } });
        try { hp.res?.end(); } catch { /* ignore */ }
      }
    }
  }

  return {
    get port() { return actualPort; },
    async start() {
      await loadStore(); // hydrate replay history from disk BEFORE accepting peers
      server = http.createServer(handler);
      await new Promise<void>((resolve) => server!.listen(port, resolve));
      const addr = server!.address();
      actualPort = typeof addr === "object" && addr ? addr.port : port;
      evictionTimer = setInterval(evictStale, pingMs);
      evictionTimer.unref?.();
    },
    async stop() {
      if (evictionTimer) { clearInterval(evictionTimer); evictionTimer = null; }
      for (const hp of peers.values()) { try { hp.res?.end(); } catch { /* ignore */ } }
      peers.clear();
      channelLogs.clear();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    },
    closeConnections() {
      // http.Server#closeAllConnections destroys the underlying sockets; SSE `close` events fire
      // on both sides (hub drops hp.res, clients schedule reconnect). The hub itself stays up.
      server?.closeAllConnections();
    },
  };
}

// Runnable standalone: `node --import <jiti>/lib/jiti-register.mjs src/hub.ts`.
async function main(): Promise<void> {
  const authToken = process.env.PI_MESH_AUTH_TOKEN;
  if (!authToken) { console.error("hub: PI_MESH_AUTH_TOKEN is required"); process.exit(1); }
  const hub = createHubServer({ authToken });
  await hub.start();
  const storeOff = process.env.PI_MESH_STORE_PATH === "off" || process.env.PI_MESH_STORE_PATH === "none";
  console.log(`armory-mesh hub listening on :${hub.port} (auth-gated)`);
  console.log(`  replay store: ${storeOff ? "off (memory-only)" : (process.env.PI_MESH_STORE_PATH ?? "~/.pi/mesh/hub-store.ndjson")}`);
  const stop = () => { void hub.stop().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// run only when invoked directly (not when imported as a module).
const invoked = (() => {
  try { return typeof process.argv[1] === "string" && process.argv[1].replace(/\\/g, "/").endsWith("src/hub.ts"); } catch { return false; }
})();
if (invoked) void main();