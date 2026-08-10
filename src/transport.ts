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
import type { Transport, Frame } from "./types.js";
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
 * Phase 6: the remote hub transport. Connects to PI_MESH_HUB_URL (HTTP+SSE);
 * messages relay through the hub. Requires PI_MESH_AUTH_TOKEN for LAN.
 */
export function createHubTransport(opts: { hubUrl: string; authToken?: string }): Transport {
  void opts;
  throw new Error("createHubTransport: not implemented (Phase 6)");
}

/**
 * Phase 6: mesh relay — if a peer is unreachable directly, ask a reachable peer to relay.
 * Visited-set + hop-count (config.maxHops) prevent loops.
 */
export function relay(_frame: Frame, _via: string, _hops: number): Promise<void> {
  throw new Error("relay: not implemented (Phase 6)");
}