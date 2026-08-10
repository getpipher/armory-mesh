// armory-mesh — the unified transport (local Unix socket ↔ remote hub, same API).
// See DESIGN.md §3.1 + ROADMAP.md Phase 1 / Phase 6.
//
// Phase 1: local Unix-socket transport.
//   - Each agent listens on paths.socket(project, agentId) (Windows: named pipe).
//   - send()/broadcast() connect to a peer's socket and push a length-prefixed JSON frame.
//   - 4-byte big-endian length prefix + UTF-8 JSON payload; the payload is capped at
//     config.maxMessageBytes (default 256KB). Oversized frames are rejected (drop + log).
//   - One frame per connection (coms style): connect → write frame → read ack → close. Keeps
//     the server simple and avoids framing-state across multiple in-flight frames per socket.
//
// Phase 6: unified auto-selection — if a peer's host != this host, route via the hub (HTTP+SSE)
//   instead of the Unix socket. The tool API (mesh_send etc.) is identical.

import net from "node:net";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { Transport, Frame } from "./types.js";
import type { Peer } from "./index.js";
import type { Registry } from "./registry.js";
import { paths } from "./paths.js";

const ACK_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 1500;

type FrameHandler = (frame: Frame, fromSocket: string) => void | Promise<void>;

function endpointFor(project: string, agentId: string): string {
  if (process.platform === "win32") {
    const safe = `${project}-${agentId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
    return `\\\\.\\pipe\\pi-mesh-${safe}`;
  }
  return paths.socket(project, agentId);
}

/** Read one length-prefixed frame from a socket. Resolves with the parsed Frame or rejects. */
function readFrame(socket: net.Socket, maxBytes: number): Promise<Frame> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let header = Buffer.alloc(0);
    let length: number | null = null;
    let settled = false;
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onErr);
      socket.removeListener("close", onClose);
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      let buf = chunk;
      if (length === null) {
        header = Buffer.concat([header, buf]);
        if (header.length < 4) return;
        length = header.readUInt32BE(0);
        if (length <= 0) {
          settled = true;
          cleanup();
          reject(new Error("transport: zero-length frame"));
          return;
        }
        if (length > maxBytes) {
          settled = true;
          cleanup();
          reject(new Error(`transport: frame exceeds cap (${length} > ${maxBytes})`));
          return;
        }
        buf = header.subarray(4);
        header = Buffer.alloc(0);
      }
      total += buf.length;
      if (total > length) {
        settled = true;
        cleanup();
        reject(new Error("transport: frame overflow"));
        return;
      }
      chunks.push(buf);
      if (total === length) {
        settled = true;
        cleanup();
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Frame);
        } catch (err) {
          reject(new Error("transport: malformed JSON frame"));
        }
      }
    };
    const onErr = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("transport: connection closed before frame received"));
    };
    socket.on("data", onData);
    socket.once("error", onErr);
    socket.once("close", onClose);
  });
}

function writeFrame(socket: net.Socket, obj: unknown, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(obj), "utf-8");
    if (body.length > maxBytes) {
      reject(new Error(`transport: frame exceeds cap (${body.length} > ${maxBytes})`));
      return;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    socket.write(Buffer.concat([header, body]), (err) => (err ? reject(err) : resolve()));
  });
}

/** Probe whether a stale socket file is truly dead (so we can reclaim it on bind). */
function probeStale(endpoint: string): Promise<"in_use" | "stale"> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      // Named pipes don't leave stale files; assume in use to be safe.
      resolve("in_use");
      return;
    }
    const sock = net.createConnection({ path: endpoint });
    let settled = false;
    const finish = (v: "in_use" | "stale") => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish("stale"), 250);
    sock.once("connect", () => {
      clearTimeout(timer);
      finish("in_use");
    });
    sock.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? "stale" : "stale");
    });
  });
}

async function bind(endpoint: string, connHandler: (socket: net.Socket) => void): Promise<net.Server> {
  if (process.platform !== "win32" && fs.existsSync(endpoint)) {
    const verdict = await probeStale(endpoint);
    if (verdict === "in_use") throw new Error(`transport: endpoint in use (${endpoint})`);
    try {
      fs.unlinkSync(endpoint);
    } catch {
      // best-effort
    }
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer(connHandler);
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.removeListener("error", reject);
      // chmod the socket 0600 so only the owner can connect (auth-by-default, even local).
      if (process.platform !== "win32") {
        try {
          fs.chmodSync(endpoint, 0o600);
        } catch {
          // best-effort
        }
      }
      resolve(server);
    });
  });
}

export interface LocalTransportOpts {
  project: string;
  agentId: string;
  maxMessageBytes: number;
  /** Resolve a peer agent id to its socket path (mesh provides this from the registry). */
  resolveSocket: (id: string) => string | undefined;
  /** All live peers (id + socket) for broadcast (mesh provides this from the registry). */
  allPeerSockets: () => Array<{ id: string; socketPath: string }>;
  onFrame?: FrameHandler;
}

export function createLocalTransport(opts: LocalTransportOpts): Transport {
  const { project, agentId, maxMessageBytes, resolveSocket, allPeerSockets } = opts;
  let server: net.Server | null = null;
  let frameHandler: FrameHandler | null = opts.onFrame ?? null;
  const endpoint = endpointFor(project, agentId);

  function connHandler(socket: net.Socket): void {
    const peerEndpoint = (socket.remoteAddress ?? "") as string;
    readFrame(socket, maxMessageBytes)
      .then(async (frame) => {
        try {
          if (frameHandler) await frameHandler(frame, peerEndpoint);
        } catch {
          // handler errors must not crash the server; drop the frame.
        }
        // ack
        try {
          await writeFrame(socket, { ok: true }, maxMessageBytes);
        } catch {
          // best-effort
        }
        try {
          socket.end();
        } catch {
          // best-effort
        }
      })
      .catch(async (err) => {
        try {
          await writeFrame(socket, { ok: false, err: err instanceof Error ? err.message : String(err) }, maxMessageBytes);
        } catch {
          // best-effort
        }
        try {
          socket.end();
        } catch {
          // best-effort
        }
      });
  }

  async function start(): Promise<void> {
    server = await bind(endpoint, connHandler);
    server.unref?.();
  }

  async function stop(): Promise<void> {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(endpoint);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          // best-effort
        }
      }
    }
  }

  async function send(to: string, frame: Frame): Promise<void> {
    const ep = resolveSocket(to);
    if (!ep) throw new Error(`transport: no socket path for peer "${to}"`);
    await sendRawFrame(ep, frame, maxMessageBytes);
  }

  async function broadcast(channel: string, frame: Frame): Promise<void> {
    void channel;
    const peers = allPeerSockets();
    await Promise.allSettled(peers.map((p) => sendRawFrame(p.socketPath, frame, maxMessageBytes)));
  }

  function onFrame(handler: FrameHandler): void {
    frameHandler = handler;
  }

  return { start, stop, send, broadcast, onFrame };
}

/**
 * Low-level frame push: connect to a raw socket endpoint, write one length-prefixed frame, read the
 * ack (best-effort), close. Exported so tests (and Phase 7 fuzzing) can inject crafted/tampered
 * frames directly against a peer's socket — bypassing the mesh's signing.
 */
export function sendRawFrame(endpointPath: string, frame: Frame, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = process.platform === "win32" ? net.createConnection(endpointPath) : net.createConnection({ path: endpointPath });
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("transport: connect timeout")), CONNECT_TIMEOUT_MS);
    socket.once("error", fail);
    socket.once("connect", async () => {
      clearTimeout(timer);
      try {
        await writeFrame(socket, frame, maxBytes);
        // Wait for the ack (best-effort; don't fail the send on a missing ack within timeout).
        await Promise.race([
          readFrame(socket, maxBytes).catch(() => undefined),
          new Promise((r) => setTimeout(r, ACK_TIMEOUT_MS)),
        ]);
        if (settled) return;
        settled = true;
        try {
          socket.end();
        } catch {
          // best-effort
        }
        resolve();
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

/**
 * Phase 6: the remote hub transport. Connects to PI_MESH_HUB_URL over SSE (inbound frames + peer
 * events) + HTTP POST (outbound join/leave/heartbeat/send). Implements BOTH Transport + Registry —
 * in hub mode the MeshCore uses one HubTransport object for both (the hub holds the live registry;
 * there's no local file registry). Requires PI_MESH_AUTH_TOKEN for LAN (auth-by-default).
 */
export interface HubTransportOpts {
  hubUrl: string;
  authToken: string;
  agentId: string;
  self: Peer;
  maxMessageBytes: number;
  onFrame?: (frame: Frame, from: string) => void | Promise<void>;
  onPeerEvent?: (type: "peer-joined" | "peer-left" | "peer-updated", peer: Peer) => void;
}

export function createHubTransport(opts: HubTransportOpts): Transport & Registry {
  const { hubUrl, authToken, agentId, self } = opts;
  const base = hubUrl.replace(/\/$/, "");
  const headers = { "x-mesh-token": authToken, "content-type": "application/json" };
  let peerList: Peer[] = [];
  let frameHandler: ((frame: Frame, from: string) => void | Promise<void>) | null = opts.onFrame ?? null;
  let peerHandler = opts.onPeerEvent ?? (() => {});
  let sseReq: import("node:http").ClientRequest | null = null;
  let sseClosed = false;

  async function post(path: string, body: unknown): Promise<unknown> {
    try {
      const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
      return await r.json().catch(() => ({}));
    } catch { return {}; }
  }

  function openSSE(): void {
    const u = new URL(base + "/events?agentId=" + encodeURIComponent(agentId));
    const lib = u.protocol === "https:" ? https : http;
    sseClosed = false;
    sseReq = lib.get(u, { headers: { "x-mesh-token": authToken } }, (res: import("node:http").IncomingMessage) => {
      let buf = "";
      res.setEncoding("utf-8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          try { dispatchSSE(JSON.parse(dataLine.slice(6)) as { type: string; [k: string]: unknown }); } catch { /* skip */ }
        }
      });
      res.on("close", () => { if (!sseClosed) setTimeout(openSSE, 1000); /* auto-reconnect */ });
    });
    sseReq.on("error", () => { if (!sseClosed) setTimeout(openSSE, 1000); });
  }

  function dispatchSSE(evt: { type: string; [k: string]: unknown }): void {
    if (evt.type === "frame" && evt.frame) { try { frameHandler?.(evt.frame as Frame, "hub"); } catch { /* ignore */ } return; }
    if (evt.type === "peers" && Array.isArray(evt.peers)) { peerList = (evt.peers as Peer[]).filter((p) => p.id !== agentId); return; }
    if (evt.type === "peer-joined" && evt.peer) { const p = evt.peer as Peer; if (p.id !== agentId && !peerList.some((x) => x.id === p.id)) peerList.push(p); peerHandler("peer-joined", p); return; }
    if (evt.type === "peer-left" && evt.peer) { const p = evt.peer as Peer; peerList = peerList.filter((x) => x.id !== p.id); peerHandler("peer-left", p); return; }
    if (evt.type === "peer-updated" && evt.peer) { const p = evt.peer as Peer; peerList = peerList.map((x) => x.id === p.id ? { ...x, ...p } : x); peerHandler("peer-updated", p); return; }
  }

  // ── Transport ─────────────────────────────────────────────────────────
  async function start(): Promise<void> { openSSE(); }
  async function stop(): Promise<void> {
    sseClosed = true;
    try { sseReq?.destroy(); } catch { /* ignore */ }
    sseReq = null;
    await post("/leave", { agentId });
  }
  async function send(to: string, frame: Frame): Promise<void> { await post("/send", { frame }); }
  async function broadcast(channel: string, frame: Frame): Promise<void> { void channel; await post("/send", { frame }); }
  function onFrame(handler: (frame: Frame, from: string) => void | Promise<void>): void { frameHandler = handler; }

  // ── Registry (hub mode: the hub holds the live registry) ───────────────
  async function join(s: Peer): Promise<void> {
    void s;
    const resp = (await post("/join", { agentId, peer: self })) as { peers?: Peer[] };
    if (Array.isArray(resp.peers)) peerList = resp.peers.filter((p) => p.id !== agentId);
  }
  async function leave(): Promise<void> { await post("/leave", { agentId }); }
  async function list(): Promise<Peer[]> { return peerList.filter((p) => p.alive !== false); }
  async function refreshPool(): Promise<Peer[]> { return list(); }
  async function heartbeat(): Promise<void> { await post("/heartbeat", { agentId }); }
  async function updateSelf(patch: Partial<Peer>): Promise<void> {
    const body: Record<string, unknown> = { agentId };
    if (patch.contextUsage !== undefined) body.contextUsage = patch.contextUsage;
    if (patch.channels !== undefined) body.channels = patch.channels;
    if (patch.claimedTarget !== undefined) body.claimedTarget = patch.claimedTarget;
    await post("/heartbeat", body);
  }
  async function updateContext(usage: number | undefined): Promise<void> { await updateSelf({ contextUsage: usage }); }
  async function updateClaim(target: string | undefined): Promise<void> { await updateSelf({ claimedTarget: target }); }

  return { start, stop, send, broadcast, onFrame, join, leave, list, refreshPool, heartbeat, updateSelf, updateContext, updateClaim, selfId: agentId } as unknown as Transport & Registry;
}

/**
 * Phase 6: mesh relay — if a peer is unreachable directly, ask a reachable peer to relay.
 * Visited-set + hop-count (config.maxHops) prevent loops.
 */
export function relay(_frame: Frame, _via: string, _hops: number): Promise<void> {
  throw new Error("relay: not implemented (Phase 6)");
}