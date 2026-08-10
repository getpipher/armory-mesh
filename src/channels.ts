// armory-mesh — channels (topics) + typed messages.
// See DESIGN.md §3.4.
//
// Phase 3 model:
//   - Channels are topics that scope delivery. The DEFAULT_CHANNELS are joined by every peer on
//     start (everyone is subscribed → mesh_send to a default channel broadcasts to all peers).
//   - Per-target channels (e.g. "#gmtrade") are joined on demand: a peer subscribes via
//     mesh.subscribe() (called by Phase 5 claim_target, or auto-join on first send to a channel).
//   - Subscription is gossiped via the heartbeat card's `channels` field, so a sender can route
//     a per-target message only to known subscribers (a small fleet doesn't spam uninterested peers).
//   - Typed payloads: mesh_send validates the payload shape against the message type and rejects
//     malformed messages (the hardened "typed messages" guarantee). `text` + `heartbeat` are free-form.

import type { MsgType, Channel, Peer } from "./index.js";

/** The default channels per project (every peer joins them on start). */
export const DEFAULT_CHANNELS = ["#general", "#dup-check", "#learnings", "#handoff", "#heartbeats"] as const;

export function isDefaultChannel(channel: string): boolean {
  return (DEFAULT_CHANNELS as readonly string[]).includes(channel);
}

/** A valid channel name starts with '#' and has no whitespace. */
export function isValidChannelName(channel: string): boolean {
  return typeof channel === "string" && /^#[^\s#]+$/.test(channel);
}

function has(obj: unknown, key: string): boolean {
  return typeof obj === "object" && obj !== null && key in obj;
}
function strField(obj: unknown, key: string): boolean {
  return has(obj, key) && typeof (obj as Record<string, unknown>)[key] === "string" && ((obj as Record<string, unknown>)[key] as string).length > 0;
}

/**
 * Validate a message's payload shape against its type. Returns a list of validation errors
 * ([] = valid). `text` and `heartbeat` are free-form (always valid).
 */
export function validateType(type: MsgType, payload: unknown): string[] {
  const errors: string[] = [];
  switch (type) {
    case "text":
    case "heartbeat":
      return errors; // free-form
    case "claim":
      if (!strField(payload, "target")) errors.push("payload.target (string) required");
      break;
    case "release":
      if (!strField(payload, "target")) errors.push("payload.target (string) required");
      break;
    case "finding":
      if (!strField(payload, "target")) errors.push("payload.target (string) required");
      if (!strField(payload, "severity")) errors.push("payload.severity (string) required");
      if (!strField(payload, "title")) errors.push("payload.title (string) required");
      if (!strField(payload, "ref")) errors.push("payload.ref (string) required");
      break;
    case "dup_check":
      if (!strField(payload, "target")) errors.push("payload.target (string) required");
      if (!strField(payload, "title")) errors.push("payload.title (string) required");
      if (!strField(payload, "rootCause")) errors.push("payload.rootCause (string) required");
      break;
    case "dup_check_result":
      if (!has(payload, "overlap") || typeof (payload as Record<string, unknown>)?.overlap !== "boolean")
        errors.push("payload.overlap (boolean) required");
      break;
    case "scope":
      if (!strField(payload, "target")) errors.push("payload.target (string) required");
      if (!strField(payload, "summary")) errors.push("payload.summary (string) required");
      break;
    case "learning":
      if (!strField(payload, "title")) errors.push("payload.title (string) required");
      if (!strField(payload, "summary")) errors.push("payload.summary (string) required");
      break;
    case "handoff":
      if (!strField(payload, "target")) errors.push("payload.target (string) required");
      if (!strField(payload, "handoffPath")) errors.push("payload.handoffPath (string) required");
      break;
    default:
      errors.push(`unknown message type "${String(type)}"`);
  }
  return errors;
}

/** The self-subscription registry: the set of channels this peer has joined. */
export interface ChannelRegistry {
  join(channel: string): void;
  leave(channel: string): void;
  has(channel: string): boolean;
  list(): string[];
}

export function createChannelRegistry(opts: { initial?: string[] } = {}): ChannelRegistry {
  const channels = new Set<string>(opts.initial ?? []);
  return {
    join(channel) {
      if (!isValidChannelName(channel)) return;
      channels.add(channel);
    },
    leave(channel) {
      channels.delete(channel);
    },
    has(channel) {
      return channels.has(channel);
    },
    list() {
      return [...channels].sort();
    },
  };
}

/**
 * Resolve the target peer ids for a channel broadcast.
 *   - default channels → every known live peer (everyone is subscribed)
 *   - per-target channels → only peers whose `channels` includes it (gossiped via heartbeats /
 *     registry). Excludes self.
 */
export function routeTargets(channel: string, knownPeers: Peer[], selfId: string): string[] {
  const targets = new Set<string>();
  for (const p of knownPeers) {
    if (p.id === selfId) continue;
    if (p.alive === false) continue;
    if (isDefaultChannel(channel) || (p.channels ?? []).includes(channel)) {
      targets.add(p.id);
    }
  }
  return [...targets];
}