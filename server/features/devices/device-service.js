import { SyncQueue } from "../../lib/sync-queue.js";
import { DeviceAccess, ownerHold } from "./device-access.js";
import { admit } from "./device-admission.js";
import { readDeviceSettings, writeDeviceSettings } from "./device-settings.js";
import { assertSource } from "./device-source.js";
import { DeviceStore } from "./device-store.js";

/*
 * Android devices as the rest of AgentPier uses them: records (device-store.js),
 * the two limits, the lifecycle, the idle stop, the owner's hold and the rule of who
 * may use or manage a device. How a device exists and runs is its source's business
 * (device-source.js); the service talks to a running device through `adb()` only.
 *
 * State lives in memory: a device is `stopped`, `starting`, `running`, `stopping` or
 * `failed` (with `failure: { code, at }`); after a restart nothing runs, because
 * `start()` lets the sources reclaim what an earlier process left.
 *
 * Two kinds of queue keep it orderly:
 * - one queue for the whole service on which every decision about the limits is
 *   taken (a start reserves its slot there before it boots), so two starts never
 *   both see the last free slot;
 * - one queue per device, on which its lifecycle operations and adb calls run one
 *   after another.
 *
 * Who may use or manage a device is decided in device-access.js. Refusals carry a
 * stable `code` and an HTTP `status`.
 */
const refusal = (code, status = 409, extra = {}) =>
  Object.assign(Error(code), { code, status, ...extra });
const stable = (error) => /^DEVICES?_[A-Z0-9_]+$/.test(error?.code || "");
const slots = ["starting", "running", "stopping"];
// A listener's failure (the topic, the audit log, another feature) is not the device's.
function quiet(call) {
  try {
    call();
  } catch (error) {
    console.error(`Android devices: a listener failed (${error?.code || "unknown"}).`);
  }
}

export class DeviceService {
  /**
   * - `sdk`: the AndroidSdk (`available()`, `manifest`); `sources`: `{ emulator }`.
   * - `changed()`: the view changed (the live topic is signalled).
   * - `audit({ action, device: { id, name }, caller })` hears `device.created`,
   *   `device.reset` and `device.deleted`.
   * - `idleMs`: a running device stops after this long without a call, or after
   *   `idleCapMs` while it is viewed or held; `busyMs`: how long after a call a device
   *   counts as in use; `sweepMs`: how often the idle stop looks.
   * - `creatorExists(creator)`: whether a device's agent or session still exists.
   * - `timers` and `store` are replaced in tests.
   */
  constructor({
    dataDir,
    sdk,
    sources,
    now = Date.now,
    changed = () => {},
    audit,
    idleMs = 900000,
    idleCapMs = 3600000,
    busyMs = 300000,
    sweepMs = 60000,
    creatorExists = () => true,
    timers = { setTimeout, clearTimeout },
    store = new DeviceStore({ dataDir, now }),
  }) {
    Object.assign(this, { dataDir, sdk, now, changed, audit, creatorExists, timers });
    Object.assign(this, { idleMs, idleCapMs, busyMs, sweepMs, store });
    this.sources = {};
    for (const [name, source] of Object.entries(sources)) {
      this.sources[name] = assertSource(source);
      source.onExit = (id, result) => this.#exited(id, result);
    }
    const { maxDevices, maxRunning } = readDeviceSettings(dataDir);
    this.limits = { maxDevices, maxRunning };
    this.admission = new SyncQueue();
    // id -> what is known about a device in memory.
    this.runtimes = new Map();
    this.access = new DeviceAccess();
    this.removed = new Set();
    this.watchers = new Set();
    this.sweepTimer = null;
    this.closed = false;
  }
  #runtime(record) {
    let runtime = this.runtimes.get(record.id);
    if (!runtime) {
      runtime = {
        state: "stopped",
        operation: null,
        failure: null,
        lastUse: record.lastUsedAt,
        viewers: 0,
        hold: null,
        queue: new SyncQueue(),
        // Calls and operations that run or wait on the queue.
        pending: 0,
        diskBytes: null,
      };
      this.runtimes.set(record.id, runtime);
    }
    return runtime;
  }
  #source(record) {
    const source = this.sources[record.source];
    if (!source) throw refusal("DEVICE_UNAVAILABLE", 409, { reason: "DEVICE_SOURCE" });
    return source;
  }
  #signal() {
    quiet(() => this.changed());
    for (const listener of [...this.watchers]) quiet(listener);
  }
  /** `listener()` hears every change of the view. Returns its removal. */
  onChanged(listener) {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }
  #record(action, record, caller) {
    quiet(() =>
      this.audit?.({
        action,
        device: { id: record.id, name: record.name },
        caller: { kind: caller?.kind, ...(caller?.id && { id: caller.id }) },
      }),
    );
  }
  #enqueue(runtime, task) {
    runtime.pending++;
    return runtime.queue.run(task).finally(() => runtime.pending--);
  }
  async #measure(record) {
    const runtime = this.runtimes.get(record.id);
    if (!runtime) return;
    try {
      runtime.diskBytes = await this.#source(record).diskBytes(record);
    } catch {
      runtime.diskBytes = null;
    }
  }
  /** Null, a host code or DEVICES_NOT_INSTALLED: why no device can run now. */
  availability() {
    return this.sdk.available();
  }
  #usable() {
    const reason = this.closed ? "DEVICES_SHUTTING_DOWN" : this.availability();
    if (reason) throw refusal("DEVICE_UNAVAILABLE", 409, { reason });
  }
  // The devices that hold a running slot, as device-admission.js reads them. A
  // device that failed to stop still has its process and counts.
  #running() {
    const live = (record, { state }) =>
      slots.includes(state) ||
      (state === "failed" &&
        this.sources[record.source]?.state(record).state !== "stopped");
    return this.store
      .list()
      .map((record) => [record, this.#runtime(record)])
      .filter(([record, runtime]) => live(record, runtime))
      .map(([{ id }, { state, lastUse, viewers, hold, pending }]) => {
        return {
          id,
          state,
          lastUse: lastUse ?? 0,
          viewers,
          held: !!hold,
          queued: pending,
        };
      });
  }
  #view(record) {
    const runtime = this.#runtime(record);
    return {
      id: record.id,
      name: record.name,
      source: record.source,
      state: runtime.state,
      operation: runtime.operation,
      failure: runtime.failure,
      creator: {
        ...record.creator,
        gone: record.creator.kind !== "owner" && !this.creatorExists(record.creator),
      },
      assignments: this.access.assignments(record.id),
      image: { id: record.image, current: record.image === this.sdk.manifest.image.id },
      diskBytes: runtime.diskBytes,
      held: !!runtime.hold,
      viewers: runtime.viewers,
      createdAt: record.createdAt,
      lastUsedAt: runtime.lastUse,
    };
  }
  /** What `GET /api/devices` answers and the `devices` topic carries. */
  view() {
    const reason = this.availability();
    const devices = this.store.list();
    return {
      availability: { available: !reason, reason },
      settings: this.settings(),
      counts: { total: devices.length, running: this.#running().length },
      devices: devices.map((record) => this.#view(record)),
    };
  }
  /** The view of one device. Throws DEVICE_NOT_FOUND (404). */
  device(id) {
    return this.#view(this.store.get(id));
  }
  settings() {
    return { ...this.limits };
  }
  /** Changes the limits. Throws DEVICES_SETTINGS_INVALID (400). */
  configure({ maxDevices, maxRunning } = {}) {
    const patch = {
      ...(maxDevices !== undefined && { maxDevices }),
      ...(maxRunning !== undefined && { maxRunning }),
    };
    const stored = writeDeviceSettings(this.dataDir, patch);
    this.limits = { maxDevices: stored.maxDevices, maxRunning: stored.maxRunning };
    this.#signal();
    return this.settings();
  }
  /** The loopback ports the devices' processes hold now. */
  ports() {
    return this.store
      .list()
      .flatMap((record) => this.sources[record.source]?.ports(record) ?? []);
  }
  /** A device runs, starts or stops (the SDK must not change under it). */
  inUse() {
    return this.#running().length > 0;
  }
  /** The system images the devices were made with; an update keeps them. */
  imagesInUse() {
    return [...new Set(this.store.list().map((record) => record.image))];
  }

  /** `{ use, manage }` of `caller` for device `id`. Throws DEVICE_NOT_FOUND (404). */
  permission(caller, id) {
    return this.access.permission(caller, this.store.get(id));
  }
  #allow(caller, id, need) {
    if (!this.permission(caller, id)[need]) throw refusal("DEVICE_FORBIDDEN", 403);
  }
  // While the owner holds a device, nobody else acts on it.
  #free(runtime, caller) {
    if (runtime.hold && caller?.kind !== "owner") throw refusal("DEVICE_HELD");
  }
  // Checks `caller`, the hold and a running reset or delete. Returns the runtime.
  #enter(id, caller, need, { held = true } = {}) {
    this.#allow(caller, id, need);
    const runtime = this.#runtime(this.store.get(id));
    if (held) this.#free(runtime, caller);
    if (runtime.operation) throw refusal("DEVICE_BUSY");
    return runtime;
  }
  /** The devices `caller` may use: `[{ ...device view, manage }]`. */
  devicesFor(caller) {
    return this.store.list().flatMap((record) => {
      const { use, manage } = this.permission(caller, record.id);
      return use ? [{ ...this.#view(record), manage }] : [];
    });
  }
  /** `resolver(callerId) -> [{ deviceId, manage }]` for callers of `kind`. */
  registerGrants(kind, resolver) {
    this.access.registerGrants(kind, resolver);
  }
  /** `lister(deviceId) -> [{ kind, id, name, manage }]`, shown in the view. */
  registerAssignments(kind, lister) {
    this.access.registerAssignments(kind, lister);
  }
  /** `listener(deviceId)` hears every removed device. Returns its removal. */
  onRemoved(listener) {
    this.removed.add(listener);
    return () => this.removed.delete(listener);
  }

  /**
   * Creates a device for `creator` (`{ kind, id, name }`) and returns its view;
   * nothing boots. Throws DEVICE_UNAVAILABLE (with `reason`), DEVICE_LIMIT_TOTAL,
   * DEVICE_NAME_INVALID (400), DEVICE_NAME_TAKEN or a refusal of the source.
   */
  create({ name, creator, source = "emulator" }) {
    return this.admission.run(async () => {
      this.#usable();
      if (this.store.list().length >= this.limits.maxDevices)
        throw refusal("DEVICE_LIMIT_TOTAL");
      const record = this.store.add({
        name,
        creator,
        source,
        image: this.sdk.manifest.image.id,
      });
      try {
        await this.#source(record).create(record);
      } catch (error) {
        this.store.remove(record.id);
        throw error;
      }
      this.#runtime(record);
      await this.#measure(record);
      this.#record("device.created", record, record.creator);
      this.#signal();
      return this.#view(record);
    });
  }
  // Takes a running slot for device `id`, stopping an idle device when none is free.
  async #admit(id) {
    this.#usable();
    for (;;) {
      const decision = admit({
        running: this.#running(),
        limit: this.limits.maxRunning,
        now: this.now(),
        busyMs: this.busyMs,
        idleCapMs: this.idleCapMs,
        wanted: id,
      });
      if (!decision.ok) throw refusal(decision.code);
      if (!decision.evict) break;
      // Its queue is empty, so the stop runs at once; it is over before the slot
      // counts as free.
      const victim = this.#runtime(this.store.get(decision.evict));
      await this.#enqueue(victim, () => this.#stop(decision.evict)).catch(() => {
        throw refusal("DEVICE_LIMIT_RUNNING");
      });
    }
    const runtime = this.runtimes.get(id);
    runtime.state = "starting";
    runtime.failure = null;
    this.#signal();
  }
  // On the device's queue: boots it unless it runs.
  async #boot(id) {
    const record = this.store.get(id);
    const runtime = this.#runtime(record);
    if (runtime.state === "running") return;
    await this.admission.run(() => this.#admit(id));
    try {
      const started = await this.#source(record).start(record);
      runtime.state = "running";
      runtime.lastUse = this.now();
      this.store.patch(id, {
        lastUsedAt: runtime.lastUse,
        ...(started?.provisioned && { provisioned: true }),
      });
    } catch (error) {
      const cancelled = error?.code === "DEVICE_START_CANCELLED";
      runtime.state = cancelled ? "stopped" : "failed";
      runtime.failure = cancelled
        ? null
        : { code: stable(error) ? error.code : "DEVICE_START_FAILED", at: this.now() };
      throw error;
    } finally {
      this.#signal();
    }
  }
  // On the device's queue: stops it, whatever state it is in.
  async #stop(id) {
    const record = this.store.get(id);
    const runtime = this.#runtime(record);
    if (runtime.state === "stopped") return;
    runtime.state = "stopping";
    this.#signal();
    try {
      await this.#source(record).stop(record);
      runtime.state = "stopped";
      runtime.failure = null;
    } catch (error) {
      runtime.state = "failed";
      runtime.failure = {
        code: stable(error) ? error.code : "DEVICE_STOP_FAILED",
        at: this.now(),
      };
      throw error;
    } finally {
      if (runtime.lastUse !== record.lastUsedAt)
        this.store.patch(id, { lastUsedAt: runtime.lastUse });
      await this.#measure(record);
      this.#signal();
    }
  }
  /**
   * Starts device `id` and resolves its view once it runs. Throws
   * DEVICE_LIMIT_RUNNING when every slot is taken by a device in use, DEVICE_BUSY,
   * DEVICE_FORBIDDEN (403), DEVICE_UNAVAILABLE or the source's start failure.
   */
  async startDevice(id, { caller } = {}) {
    const runtime = this.#enter(id, caller, "use", { held: false });
    await this.#enqueue(runtime, () => this.#boot(id));
    return this.device(id);
  }
  /** Stops device `id` after the calls that wait for it. Resolves its view. */
  async stopDevice(id, { caller } = {}) {
    const runtime = this.#enter(id, caller, "use");
    await this.#enqueue(runtime, () => this.#stop(id));
    return this.device(id);
  }
  // A reset or delete: announced at once, run on the device's queue.
  async #operate(id, caller, operation, work) {
    const runtime = this.#enter(id, caller, "manage");
    runtime.operation = operation;
    this.#signal();
    try {
      return await this.#enqueue(runtime, () => work(this.store.get(id), runtime));
    } finally {
      runtime.operation = null;
      this.#signal();
    }
  }
  // After a source operation that stops the device itself.
  #settle(record, runtime) {
    const { state } = this.#source(record).state(record);
    runtime.state = state;
    if (state === "stopped") runtime.failure = null;
  }
  /**
   * Returns device `id` to the factory state on the pinned image; id, name and
   * assignments stay. Needs `manage`. Resolves the device's view.
   */
  async reset(id, { caller } = {}) {
    await this.#operate(id, caller, "reset", async (record, runtime) => {
      try {
        const { image } = await this.#source(record).reset(record);
        this.store.patch(id, { image, provisioned: false, resetAt: this.now() });
        this.#record("device.reset", record, caller);
      } finally {
        this.#settle(record, runtime);
        await this.#measure(record);
      }
    });
    return this.device(id);
  }
  /** Deletes device `id` with everything on it. Needs `manage`. */
  async remove(id, { caller } = {}) {
    await this.#operate(id, caller, "delete", async (record, runtime) => {
      try {
        await this.#source(record).remove(record);
      } catch (error) {
        this.#settle(record, runtime);
        throw error;
      }
      this.#forget(record);
      this.#record("device.deleted", record, caller);
    });
  }
  #forget(record) {
    const runtime = this.runtimes.get(record.id);
    if (runtime?.hold) this.timers.clearTimeout(runtime.hold.timer);
    this.store.remove(record.id);
    this.runtimes.delete(record.id);
    for (const listener of this.removed) quiet(() => listener(record.id));
  }
  /**
   * Deletes every device, before the SDK is removed. Throws DEVICES_IN_USE while one
   * runs, starts or stops.
   */
  removeAll() {
    return this.admission.run(async () => {
      if (this.inUse()) throw refusal("DEVICES_IN_USE");
      for (const record of this.store.list()) {
        await this.#source(record).remove(record);
        this.#forget(record);
        this.#record("device.deleted", record, { kind: "owner" });
      }
      this.#signal();
    });
  }
  /**
   * Runs `adb <args>` on device `id`, after the calls that wait for it, and resolves
   * `{ stdout, stderr, code, truncated }`. A stopped device is started first unless
   * `start` is false (DEVICE_NOT_RUNNING then). Throws DEVICE_HELD while the owner
   * holds the device and the caller is someone else, DEVICE_BUSY during a reset or
   * delete, DEVICE_FORBIDDEN (403), or what the start throws. The other options are
   * AdbClient#exec's: `timeoutMs`, `maxBytes`, `input`, `signal`, `encoding`.
   */
  async adb(id, args, { caller, start = true, ...options } = {}) {
    const runtime = this.#enter(id, caller, "use");
    return this.#enqueue(runtime, async () => {
      const record = this.store.get(id);
      // The owner may have taken the device while this call waited.
      this.#free(runtime, caller);
      if (runtime.state !== "running") {
        if (!start) throw refusal("DEVICE_NOT_RUNNING");
        await this.#boot(id);
      }
      runtime.lastUse = this.now();
      try {
        return await this.#source(record).exec(record, args, options);
      } finally {
        runtime.lastUse = this.now();
      }
    });
  }
  /**
   * The owner holds device `id` for `ms`: other callers are refused meanwhile, and
   * the device is neither stopped for another nor by the idle stop before its cap.
   * Returns `{ release(), extend(ms), until }`; a new hold replaces an earlier one.
   */
  hold(id, { ms }) {
    const runtime = this.#runtime(this.store.get(id));
    return ownerHold(runtime, ms, {
      now: this.now,
      timers: this.timers,
      changed: () => this.#signal(),
    });
  }
  /** Until when the owner holds device `id`, or null. */
  heldUntil(id) {
    return this.#runtime(this.store.get(id)).hold?.until ?? null;
  }
  /** A viewer looks at device `id`. Returns the function that ends it. */
  watch(id) {
    const runtime = this.#runtime(this.store.get(id));
    runtime.viewers++;
    this.#signal();
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      runtime.viewers--;
      this.#signal();
    };
  }

  #exited(id) {
    const runtime = this.runtimes.get(id);
    if (runtime?.state !== "running") return;
    runtime.state = "failed";
    runtime.failure = { code: "DEVICE_EXITED", at: this.now() };
    this.#signal();
  }
  /** Stops every running device that was not used for too long. */
  async sweep() {
    const now = this.now();
    await Promise.all(
      this.store.list().map((record) => {
        const runtime = this.#runtime(record);
        if (runtime.state !== "running" || runtime.pending || runtime.operation) return;
        const kept = runtime.viewers > 0 || runtime.hold;
        if (now - (runtime.lastUse ?? 0) < (kept ? this.idleCapMs : this.idleMs)) return;
        return this.#enqueue(runtime, () => this.#stop(record.id)).catch(() => {});
      }),
    );
  }
  #schedule() {
    if (this.closed) return;
    this.sweepTimer = this.timers.setTimeout(async () => {
      await this.sweep().catch(() => {});
      this.#schedule();
    }, this.sweepMs);
    this.sweepTimer?.unref?.();
  }
  /**
   * At server start: the sources stop what an earlier process left running, so no
   * device runs afterwards; then the idle stop begins. Never throws.
   */
  async start() {
    const records = this.store.list();
    for (const [name, source] of Object.entries(this.sources))
      await source
        .reclaim(records.filter((record) => record.source === name))
        .catch((error) =>
          console.warn(`Android devices: reclaim failed (${error?.code || "unknown"}).`),
        );
    for (const record of records) this.#runtime(record).state = "stopped";
    await Promise.all(records.map((record) => this.#measure(record)));
    this.#schedule();
    this.#signal();
  }
  /**
   * Stops every device for a shutdown and returns after `graceMs` at the latest;
   * what is left then, the next start reclaims. Nothing starts afterwards.
   */
  async shutdown({ graceMs = 3000 } = {}) {
    this.closed = true;
    this.timers.clearTimeout(this.sweepTimer);
    for (const runtime of this.runtimes.values())
      if (runtime.hold) this.timers.clearTimeout(runtime.hold.timer);
    let timer;
    const bound = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, graceMs);
    });
    // The sources get less than the bound, so their last resort still happens.
    const closing = Promise.all(
      Object.values(this.sources).map((source) =>
        source.close({ graceMs: Math.floor((graceMs * 2) / 3) }).catch(() => {}),
      ),
    );
    await Promise.race([closing, bound]);
    this.timers.clearTimeout(timer);
  }
}
