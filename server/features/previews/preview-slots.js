import { createHash } from "node:crypto";
import path from "node:path";
import { portAvailable } from "../pipelines/run-ports.js";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { previewError } from "./preview-errors.js";

// Tailscale Serve owns the slot port on the tailnet and forwards it to this loopback port.
export const TAILSCALE_LISTENER_OFFSET = 1000;

/**
 * The port AgentPier listens on for a slot. Every caller goes through this function:
 * the slot itself, or `slot + offset` while Tailscale Serve fronts the slot.
 */
export const listenerPort = (slot, { offset = 0 } = {}) => slot + offset;

/**
 * The listener offset of a config: Tailscale Serve registrations are active with a remote
 * URL while network mode is off; network mode and loopback bind the slot itself.
 */
export const listenerOffset = (config = {}) =>
  config.remoteUrl && !config.network?.enabled ? TAILSCALE_LISTENER_OFFSET : 0;

const digest = (key) =>
  createHash("sha256").update(String(key)).digest("hex").slice(0, 16);

/**
 * The preview slots of a configured port range. A key (a project path, an agent) gets
 * the slot it used last when that is free, otherwise the least recently used free one.
 * A slot is reserved before it is probed, so concurrent allocations never share one.
 * The sticky memory on disk holds only a hash of each key.
 */
export class PreviewSlots {
  constructor({
    range,
    probe = portAvailable,
    file,
    forbidden = () => new Set(),
    offset = 0,
  }) {
    Object.assign(this, { range, probe, file, forbidden, offset });
    this.reserved = new Set();
    this.order = this.slots(); // least recently used first
  }
  slots() {
    const ports = [];
    for (let port = this.range.start; port <= this.range.end; port++) ports.push(port);
    return ports;
  }
  busy() {
    return new Set(this.reserved);
  }
  stored() {
    const saved = this.file ? readJSON(this.file, {}) : {};
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  }
  async allocate({ key }) {
    const hash = digest(key);
    const stored = this.stored();
    const sticky = this.order.find((slot) => stored[slot] === hash);
    const candidates = sticky === undefined ? this.order : [sticky, ...this.order];
    const tried = new Set();
    for (const slot of candidates) {
      if (tried.has(slot)) continue;
      tried.add(slot);
      if (this.reserved.has(slot) || this.forbidden().has(slot)) continue;
      this.reserved.add(slot);
      let accepted = false;
      try {
        const free = await this.probe(listenerPort(slot, { offset: this.offset }));
        if (free) this.remember(slot, key);
        accepted = Boolean(free);
      } finally {
        if (!accepted) this.reserved.delete(slot);
      }
      if (accepted) return slot;
    }
    throw previewError("PREVIEW_RANGE_FULL", 409);
  }
  release(slot) {
    this.reserved.delete(slot);
    const index = this.order.indexOf(slot);
    if (index >= 0) this.order.splice(index, 1);
    this.order.push(slot);
  }
  remember(slot, key) {
    if (!this.file) return;
    const known = new Set(this.slots().map(String));
    const stored = Object.fromEntries(
      Object.entries(this.stored()).filter(([name]) => known.has(name)),
    );
    stored[slot] = digest(key);
    writePrivate(this.file, stored);
  }
}

export const slotsFile = (dataDir) => path.join(dataDir, "previews", "slots.json");
