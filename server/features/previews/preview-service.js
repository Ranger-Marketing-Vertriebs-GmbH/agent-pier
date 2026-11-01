import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { portAvailable } from "../pipelines/run-ports.js";
import { networkUrls } from "../remote/network-access.js";
import { previewConfig, previewGate } from "./preview-access.js";
import {
  normalizePreviewConfig,
  readPreviewConfig,
  tailscaleHttpsPort,
  writePreviewConfig,
} from "./preview-config.js";
import { previewError } from "./preview-errors.js";
import { createPreviewListener } from "./preview-proxy.js";
import { PreviewRegistrations } from "./preview-registrations.js";
import {
  listenerOffset,
  listenerPort,
  PreviewSlots,
  slotsFile,
} from "./preview-slots.js";
import { forbiddenTarget, targetAddress } from "./preview-targets.js";

const DAY = 24 * 60 * 60 * 1000;
// A label or path with a control character could forge lines in a log or a card.
const controls = /[\u0000-\u001f\u007f]/;
const invalid = () => previewError("PREVIEW_INVALID_INPUT", 400);
const iso = (time) => new Date(time).toISOString();
const rangeOf = (settings) => ({
  start: settings.portRangeStart,
  end: settings.portRangeEnd,
});

function checkedInput({ owner, port, label, path } = {}) {
  const session =
    owner?.kind === "session" && typeof owner.sessionId === "string" && owner.sessionId;
  const agent =
    owner?.kind === "agent" &&
    typeof owner.assistantId === "string" &&
    owner.assistantId &&
    typeof owner.conversationId === "string" &&
    owner.conversationId;
  if (!session && !agent) throw invalid();
  if (typeof owner.project !== "string" || !owner.project) throw invalid();
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw invalid();
  if (label !== undefined) {
    if (typeof label !== "string" || !label.trim() || label.length > 80) throw invalid();
    if (controls.test(label)) throw invalid();
  }
  if (path !== undefined) {
    if (typeof path !== "string" || path.length > 2048 || !/^\/(?!\/)/.test(path))
      throw invalid();
    // WHATWG URL parsing reads a backslash as a slash, so a path like /\x//y would become "//y".
    if (controls.test(path) || path.includes("\\")) throw invalid();
    // Spaces and other raw characters leave the URL (and Markdown links) intact.
    const url = new URL(path, "http://x");
    path = url.pathname + url.search + url.hash;
    // Dot segments ("/.//x") can also normalise into a protocol-relative path.
    if (path.startsWith("//")) throw invalid();
  }
  return { owner, port, label, path };
}

/** The owner as the API shows it: never the project path. */
const ownerView = (owner) =>
  owner.kind === "session"
    ? { kind: "session", sessionId: owner.sessionId }
    : {
        kind: "agent",
        assistantId: owner.assistantId,
        conversationId: owner.conversationId,
      };

/** One preview per (session or agent conversation, target port). */
const ownerKey = (owner, port) =>
  owner.kind === "session"
    ? `session\0${owner.sessionId}\0${port}`
    : `agent\0${owner.conversationId}\0${port}`;

/**
 * The previews of sessions and agents: a pool of slot ports, each with its own listener
 * (preview-proxy.js) that forwards the owner's requests to one loopback dev server.
 * Previews live in memory only; listeners stay bound on every free slot while previews
 * are enabled and answer the idle page without one.
 */
export class PreviewService extends EventEmitter {
  constructor({
    dataDir,
    effective,
    bindHost = () => "127.0.0.1",
    detected = () => undefined,
    identity,
    audit,
    live = () => null,
    sessionAlive = () => false,
    agentAlive = () => false,
    internalPorts = () => [],
    probe = portAvailable,
    tailscaleRun,
    now = Date.now,
    idleMs = DAY,
  }) {
    super();
    Object.assign(this, {
      dataDir,
      effective,
      bindHost,
      detected,
      identity,
      audit,
      live,
      sessionAlive,
      agentAlive,
      internalPorts,
      probe,
      tailscaleRun,
      now,
      idleMs,
    });
    this.previews = new Map(); // id → preview
    this.listeners = new Map(); // slot → listener
    this.binding = new Map(); // slot → bind in flight
    this.slots = null;
    this.offset = 0; // listenerPort offset of the bound listeners (preview-slots.js)
    this.serve = new PreviewRegistrations(tailscaleRun); // Tailscale Serve, this process
    this.previousRange = null; // the range a running start replaces
    this.starting = null;
    this.stopped = false;
    this.queue = Promise.resolve();
  }

  current() {
    return previewConfig(this.effective);
  }

  constraints() {
    const current = this.current();
    return {
      hostPort: current.port,
      pipelineRange: current.portRange,
      tailscaleHttpsPort: tailscaleHttpsPort(current.remoteUrl),
    };
  }

  settings() {
    return readPreviewConfig(this.dataDir, this.constraints());
  }

  /** A settings body validated like the saved config; PREVIEW_RANGE_INVALID otherwise. */
  checked(raw) {
    return normalizePreviewConfig(raw ?? undefined, this.constraints());
  }

  /**
   * Saves new settings and applies them: switching off closes every preview and unbinds
   * every slot; a new range closes the previews whose slot leaves it, unbinds those
   * slots and binds the new ones. Serialized with open().
   */
  configure(next, { source = "user" } = {}) {
    const run = this.queue.then(() => this.configuring(next, source));
    this.queue = run.catch(() => {});
    return run;
  }

  async configuring(raw, source) {
    const next = this.checked(raw);
    const before = this.settings();
    writePreviewConfig(this.dataDir, next);
    try {
      await this.apply(next, before, source);
    } catch (error) {
      // A failed apply restores the previous settings, so the saved ones match what runs.
      try {
        writePreviewConfig(this.dataDir, before);
      } catch (restore) {
        console.error(
          `AgentPier could not restore the preview settings: ${restore?.code || "unknown error"}`,
        );
      }
      throw error;
    }
    this.recordSettings(next, source);
    this.changed();
    return this.view();
  }

  async apply(next, before, source) {
    const { portRangeStart: start, portRangeEnd: end } = next;
    const inside = (slot) => next.enabled && slot >= start && slot <= end;
    for (const preview of [...this.previews.values()])
      if (!inside(preview.slot))
        await this.close(preview.id, {
          reason: next.enabled ? "range" : "disabled",
          source,
        }).catch((error) =>
          console.error(
            `AgentPier could not close a preview: ${error?.code || error?.status || "unknown error"}`,
          ),
        );
    // A bind in flight settles first, so it cannot add a listener afterwards.
    await Promise.allSettled([...this.binding.values()]);
    for (const [slot, listener] of [...this.listeners])
      if (!inside(slot)) {
        this.listeners.delete(slot);
        await listener.close().catch(() => {});
      }
    const moved = before.portRangeStart !== start || before.portRangeEnd !== end;
    if (before.enabled && !next.enabled) await this.serve.remove(rangeOf(before));
    else if (before.enabled && moved) this.previousRange = rangeOf(before);
    // Remote access changed since the last start: start afresh in the new mode.
    const remode = listenerOffset(this.current()) !== this.offset;
    if (!next.enabled || moved || remode) {
      clearInterval(this.timer);
      this.slots = null;
    }
    // A start that found previews off is memoized; enabling starts afresh.
    if (!this.slots) this.starting = null;
    await this.ensureStarted();
  }

  recordSettings(next, source) {
    try {
      this.audit?.append({
        action: "setting.updated",
        resourceType: "setting",
        resourceId: "previews",
        outcome: "success",
        source,
        details: {
          enabled: next.enabled,
          count: next.portRangeEnd - next.portRangeStart + 1,
        },
      });
    } catch (error) {
      console.error(
        `AgentPier could not audit the preview settings: ${error?.code || "unknown error"}`,
      );
    }
  }

  /** Binds every free slot and starts the idle sweep once while enabled; serialized. */
  start() {
    const run = this.queue.then(() => this.ensureStarted());
    this.queue = run.catch(() => {});
    return run;
  }

  ensureStarted() {
    if (this.stopped) return Promise.resolve();
    // A failed start is not kept: the next start or open tries again.
    return (this.starting ??= this.run().catch((error) => {
      this.starting = null;
      throw error;
    }));
  }

  async run() {
    const settings = this.settings();
    if (!settings.enabled) return;
    const range = rangeOf(settings);
    const offset = listenerOffset(this.current());
    if (offset !== this.offset) {
      // Remote access changed since the last start: rebind at the new listener ports.
      const stale = [...this.listeners.values()];
      this.listeners.clear();
      await Promise.all(stale.map((listener) => listener.close().catch(() => {})));
      this.offset = offset;
    }
    const previousRange = this.previousRange;
    this.previousRange = null;
    await this.serve.sync({ tailscale: offset > 0, range, previousRange });
    this.slots = new PreviewSlots({
      range,
      offset,
      // With Tailscale only the slots Serve forwards can be reached.
      forbidden: () => (this.offset ? this.serve.unserved(range) : new Set()),
      // A slot is free when its listener is ours or can be bound now.
      probe: (port) => this.bind(this.slotOf(port)),
      file: slotsFile(this.dataDir),
    });
    // Previews that stay open keep their slot across a range change.
    for (const preview of this.previews.values()) this.slots.reserved.add(preview.slot);
    for (const slot of this.slots.slots()) await this.bind(slot);
    clearInterval(this.timer);
    if (this.stopped) return;
    this.timer = setInterval(
      () => (this.stopped ? undefined : this.sweep().catch(() => {})),
      Math.min(this.idleMs, 60_000),
    );
    this.timer.unref();
    this.changed();
  }

  slotOf(port) {
    return this.slots.slots().find((slot) => this.portOf(slot) === port);
  }

  portOf(slot) {
    return listenerPort(slot, { offset: this.offset });
  }

  /** With Tailscale, the slot port stays free for tailscaled unless Serve holds it. */
  async slotFree(slot) {
    if (!(await this.probe(this.portOf(slot)))) return false;
    if (!this.offset || this.serve.has(slot)) return true;
    return this.probe(slot);
  }

  /** The owner cannot reach a slot that Tailscale Serve does not forward. */
  unreachable(slot) {
    return this.offset > 0 && !this.serve.has(slot);
  }

  /** Whether the slot has our listener (binding it when the port is free). */
  bind(slot) {
    if (slot === undefined || this.stopped) return Promise.resolve(false);
    if (this.listeners.has(slot)) return Promise.resolve(true);
    // start() and an open's allocation never bind the same slot twice.
    if (!this.binding.has(slot))
      this.binding.set(
        slot,
        this.bindNow(slot).finally(() => this.binding.delete(slot)),
      );
    return this.binding.get(slot);
  }

  async bindNow(slot) {
    if (!(await this.slotFree(slot))) return false;
    const port = this.portOf(slot);
    try {
      const listener = await createPreviewListener({
        slot,
        port,
        host: this.bindHost(),
        gate: previewGate({
          login: this.identity(),
          effective: this.effective,
          slot,
          port,
          detected: this.detected(),
        }),
        resolve: (asked) => this.resolve(asked),
        touch: (preview) => (preview.usedAt = this.now()),
        watch: (session, close) => this.identity().watch(session, close),
        effective: this.effective,
      });
      if (this.stopped) {
        await listener.close();
        return false;
      }
      this.listeners.set(slot, listener);
      return true;
    } catch {
      return false;
    }
  }

  /** The open preview of a slot whose owner still runs; otherwise null (idle page). */
  async resolve(slot) {
    const preview = [...this.previews.values()].find((entry) => entry.slot === slot);
    if (!preview) return null;
    if (!(await this.alive(preview))) {
      const reason = preview.owner.kind === "session" ? "session" : "conversation";
      await this.close(preview.id, { reason, source: "system" }).catch(() => {});
      return null;
    }
    return { preview, address: preview.address };
  }

  async alive({ owner }) {
    try {
      if (owner.kind === "session") return Boolean(this.sessionAlive(owner.sessionId));
      return Boolean(
        await this.agentAlive({
          assistantId: owner.assistantId,
          conversationId: owner.conversationId,
        }),
      );
    } catch {
      return false;
    }
  }

  /** Opens (or updates) the preview of an owner's target port. */
  open(input) {
    const run = this.queue.then(() => this.opening(input));
    this.queue = run.catch(() => {});
    return run;
  }

  async opening(input) {
    if (!this.settings().enabled || this.stopped)
      throw previewError("PREVIEW_DISABLED", 409);
    const { owner, port, label, path } = checkedInput(input);
    if (!this.slots) await this.ensureStarted();
    if (!this.slots) {
      // Enabled after the start: bind now.
      this.starting = null;
      await this.ensureStarted();
    }
    if (!this.slots) throw previewError("PREVIEW_DISABLED", 409);
    const internal = new Set(this.internalPorts());
    for (const slot of this.slots.slots()) internal.add(this.portOf(slot));
    if (
      forbiddenTarget(port, {
        hostPort: this.current().port,
        range: this.slots.range,
        internal,
      })
    )
      throw previewError("PREVIEW_PORT_FORBIDDEN", 403, port);
    const address = await targetAddress(port);
    if (!address) throw previewError("PREVIEW_NOT_LISTENING", 409, port);
    // A stopped session, a revoked grant or a deleted chat opens nothing.
    if (!(await this.alive({ owner }))) throw previewError("PREVIEW_NOT_FOUND", 404);
    const key = ownerKey(owner, port);
    let preview = [...this.previews.values()].find((entry) => entry.key === key);
    // No slot Serve forwards (or this preview's slot lost it): nothing reaches the owner.
    if (
      preview
        ? this.unreachable(preview.slot)
        : this.offset && !this.serve.state.registered.length
    )
      throw previewError("PREVIEW_UNAVAILABLE", 503);
    if (preview) {
      Object.assign(preview, { address, usedAt: this.now() });
      if (label !== undefined) preview.label = label;
      if (path !== undefined) preview.path = path;
    } else {
      const slot = await this.slots.allocate({ key: `${owner.project}\0${port}` });
      const time = this.now();
      preview = {
        id: randomUUID(),
        key,
        slot,
        target: port,
        address,
        label: label ?? String(port),
        path: path ?? "/",
        owner: ownerView(owner),
        createdAt: time,
        usedAt: time,
      };
      this.previews.set(preview.id, preview);
      this.record("preview.started", preview, {
        reason: "tool",
        source: owner.kind === "session" ? "mcp" : "agent",
      });
    }
    this.changed();
    return {
      id: preview.id,
      url: this.previewUrl(preview),
      port: preview.target,
      label: preview.label,
    };
  }

  /** The address the owner opens: Tailscale, else the network, else loopback. */
  previewUrl({ slot, path = "/" }) {
    const current = this.current();
    let origin = `http://127.0.0.1:${slot}`;
    if (listenerOffset(current))
      origin = `https://${new URL(current.remoteUrl).hostname}:${slot}`;
    else if (current.network?.enabled) {
      const [first] = networkUrls(current.network, slot, this.detected());
      if (first) origin = first;
    }
    return `${origin}${path}`;
  }

  async close(id, { reason = "owner", source = "user" } = {}) {
    const preview = this.previews.get(id);
    if (!preview) throw previewError("PREVIEW_NOT_FOUND", 404);
    this.previews.delete(id);
    // Its WebSockets and streams end with it, before the slot can serve another.
    this.listeners.get(preview.slot)?.drop?.();
    this.slots?.release(preview.slot);
    this.record(reason === "expired" ? "preview.expired" : "preview.stopped", preview, {
      reason,
      source,
    });
    this.changed();
    return { closed: true };
  }

  async closeWhere(match, reason) {
    for (const preview of [...this.previews.values()])
      if (match(preview.owner))
        await this.close(preview.id, { reason, source: "system" }).catch(() => {});
  }

  closeSession(sessionId, reason = "session") {
    return this.closeWhere((owner) => owner.sessionId === sessionId, reason);
  }

  closeConversation(conversationId, reason = "conversation") {
    return this.closeWhere((owner) => owner.conversationId === conversationId, reason);
  }

  /** Ends agent previews idle for `idleMs` and previews whose owner is gone. */
  async sweep() {
    for (const preview of [...this.previews.values()]) {
      if (!this.previews.has(preview.id)) continue;
      const agent = preview.owner.kind === "agent";
      if (agent && this.now() - preview.usedAt >= this.idleMs)
        await this.close(preview.id, { reason: "expired", source: "system" }).catch(
          () => {},
        );
      else if (!(await this.alive(preview)))
        await this.close(preview.id, {
          reason: agent ? "conversation" : "session",
          source: "system",
        }).catch(() => {});
    }
  }

  list({ sessionId, conversationId } = {}) {
    return [...this.previews.values()]
      .filter(
        (preview) =>
          (sessionId === undefined || preview.owner.sessionId === sessionId) &&
          (conversationId === undefined ||
            preview.owner.conversationId === conversationId),
      )
      .map((preview) => ({
        id: preview.id,
        slot: preview.slot,
        target: preview.target,
        label: preview.label,
        path: preview.path,
        owner: { ...preview.owner },
        createdAt: iso(preview.createdAt),
        lastUsedAt: iso(preview.usedAt),
      }));
  }

  async view() {
    const settings = this.settings();
    const previews = this.list();
    const used = new Set(previews.map((preview) => preview.slot));
    const slots = [];
    for (let port = settings.portRangeStart; port <= settings.portRangeEnd; port++) {
      let state = "taken";
      if (used.has(port)) state = "preview";
      else if (this.listeners.has(port)) state = "free";
      else if (await this.slotFree(port)) state = "free";
      slots.push({ port, state });
    }
    return { settings, previews, slots, serve: this.serve.view(this.current()) };
  }

  /** Closes listeners and their sockets; Tailscale Serve registrations stay. */
  async shutdown() {
    this.stopped = true;
    clearInterval(this.timer);
    const listeners = [...this.listeners.values()];
    this.listeners.clear();
    this.previews.clear();
    await Promise.all(listeners.map((listener) => listener.close()));
  }

  /** Audit row: owner kind, target port, slot and reason; never a URL or header. */
  record(action, preview, { reason, source }) {
    try {
      this.audit?.append({
        action,
        resourceType: "preview",
        resourceId: preview.id,
        ...(preview.owner.kind === "session"
          ? { sessionId: preview.owner.sessionId }
          : {}),
        source,
        outcome: "success",
        details: {
          kind: "preview",
          owner: preview.owner.kind,
          targetPort: preview.target,
          slot: preview.slot,
          reason,
        },
      });
    } catch (error) {
      // A preview (and a session stop closing it) never fails on its audit row; the
      // log names the error code only, never a URL or header.
      console.error(
        `AgentPier could not audit a preview: ${error?.code || error?.status || "unknown error"}`,
      );
    }
  }

  changed() {
    this.emit("changed");
    this.live()?.invalidate?.("previews");
  }
}
