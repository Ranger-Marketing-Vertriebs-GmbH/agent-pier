import { DeviceAccess, ownerHold } from "./device-access.js";
import { deviceView, newRuntime, slots } from "./device-runtime.js";
import { readDeviceSettings, writeDeviceSettings } from "./device-settings.js";
import { assertSource } from "./device-source.js";
import { DeviceStore } from "./device-store.js";

/*
 * The devices as AgentPier knows them at one moment: their records
 * (device-store.js), what is known about each in memory (device-runtime.js), the two
 * limits, the view of it all, who may use or manage a device (device-access.js),
 * the owner's hold, the viewers, and the listeners that hear of changes.
 *
 * Nothing here starts, stops or changes a device: that is the lifecycle in
 * device-service.js, whose class extends this one and is what the rest of AgentPier
 * uses. The methods without a caller outside (`runtimeOf`, `sourceOf`, `signal`,
 * `audited`, `live`, `measure`, `running`, `forget`) are there for it.
 */
/** A refusal with a stable `code`, an HTTP `status` and further fields. */
export const refusal = (code, status = 409, extra = {}) =>
  Object.assign(Error(code), { code, status, ...extra });
// A listener's failure (the topic, the audit log, another feature) is not the device's.
function quiet(call) {
  try {
    call();
  } catch (error) {
    console.error(`Android devices: a listener failed (${error?.code || "unknown"}).`);
  }
}

export class DeviceRegistry {
  /**
   * - `sdk`: the AndroidSdk (`available()`, `manifest`); `sources`: `{ emulator }`.
   * - `changed()`: the view changed (the live topic is signalled).
   * - `audit({ action, device: { id, name }, caller })` hears `device.created`,
   *   `device.reset` and `device.deleted`.
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
    creatorExists = () => true,
    timers = { setTimeout, clearTimeout },
    store = new DeviceStore({ dataDir, now }),
  }) {
    Object.assign(this, { dataDir, sdk, now, changed, audit, creatorExists, timers });
    this.store = store;
    this.sources = {};
    for (const [name, source] of Object.entries(sources))
      this.sources[name] = assertSource(source);
    const { maxDevices, maxRunning } = readDeviceSettings(dataDir);
    this.limits = { maxDevices, maxRunning };
    // id -> what is known about a device in memory.
    this.runtimes = new Map();
    this.access = new DeviceAccess();
    this.removed = new Set();
    this.watchers = new Set();
  }
  /** What is known in memory about the device of `record` (device-runtime.js). */
  runtimeOf(record) {
    let runtime = this.runtimes.get(record.id);
    if (!runtime) this.runtimes.set(record.id, (runtime = newRuntime(record)));
    return runtime;
  }
  /** The source of the device of `record`. Throws DEVICE_UNAVAILABLE (DEVICE_SOURCE). */
  sourceOf(record) {
    const source = this.sources[record.source];
    if (!source) throw refusal("DEVICE_UNAVAILABLE", 409, { reason: "DEVICE_SOURCE" });
    return source;
  }
  /** Tells everyone that the view changed. */
  signal() {
    quiet(() => this.changed());
    for (const listener of [...this.watchers]) quiet(listener);
  }
  /** `listener()` hears every change of the view. Returns its removal. */
  onChanged(listener) {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }
  /** Reports `action` on the device of `record` by `caller` to the audit log. */
  audited(action, record, caller) {
    quiet(() =>
      this.audit?.({
        action,
        device: { id: record.id, name: record.name },
        caller: { kind: caller?.kind, ...(caller?.id && { id: caller.id }) },
      }),
    );
  }
  /** Whether the source still has a process for the device of `record`. */
  live(record) {
    return (this.sources[record.source]?.state(record).state ?? "stopped") !== "stopped";
  }
  /** Measures the size of the device of `record` on disk, for the view. */
  async measure(record) {
    const runtime = this.runtimes.get(record.id);
    if (!runtime) return;
    try {
      runtime.diskBytes = await this.sourceOf(record).diskBytes(record);
    } catch {
      runtime.diskBytes = null;
    }
  }
  /** Null, a host code or DEVICES_NOT_INSTALLED: why no device can run now. */
  availability() {
    return this.sdk.available();
  }
  /**
   * The devices that hold a running slot, as device-admission.js reads them. A
   * device that failed to stop still has its process and counts.
   */
  running() {
    const live = (record, { state }) =>
      slots.includes(state) || (state === "failed" && this.live(record));
    return this.store
      .list()
      .map((record) => [record, this.runtimeOf(record)])
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
    return deviceView(record, this.runtimeOf(record), {
      live: this.live(record),
      gone: record.creator.kind !== "owner" && !this.creatorExists(record.creator),
      assignments: this.access.assignments(record.id),
      pinned: this.sdk.manifest.image.id,
    });
  }
  /** What `GET /api/devices` answers and the `devices` topic carries. */
  view() {
    const reason = this.availability();
    const devices = this.store.list();
    return {
      availability: { available: !reason, reason },
      settings: this.settings(),
      counts: { total: devices.length, running: this.running().length },
      devices: devices.map((record) => this.#view(record)),
    };
  }
  /**
   * `{ state, operation }` of device `id` as it is known in memory, or null for a
   * device nobody has asked about: no record is read and no view is built.
   */
  status(id) {
    const runtime = this.runtimes.get(id);
    return runtime ? { state: runtime.state, operation: runtime.operation } : null;
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
    this.signal();
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
    return this.running().length > 0;
  }
  /** The system images the devices were made with; an update keeps them. */
  imagesInUse() {
    return [...new Set(this.store.list().map((record) => record.image))];
  }

  /** `{ use, manage }` of `caller` for device `id`. Throws DEVICE_NOT_FOUND (404). */
  permission(caller, id) {
    return this.access.permission(caller, this.store.get(id));
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
  /** Drops the record and the runtime of a device that was removed, and says so. */
  forget(record) {
    const runtime = this.runtimes.get(record.id);
    if (runtime?.hold) this.timers.clearTimeout(runtime.hold.timer);
    this.store.remove(record.id);
    this.runtimes.delete(record.id);
    for (const listener of this.removed) quiet(() => listener(record.id));
  }
  /**
   * The owner holds device `id` for `ms`: other callers are refused meanwhile, and
   * the device is neither stopped for another nor by the idle stop before its cap.
   * Returns `{ release(), extend(ms), until }`; a new hold replaces an earlier one.
   */
  hold(id, { ms }) {
    const runtime = this.runtimeOf(this.store.get(id));
    return ownerHold(runtime, ms, {
      now: this.now,
      timers: this.timers,
      changed: () => this.signal(),
    });
  }
  /** Until when the owner holds device `id`, or null. */
  heldUntil(id) {
    return this.runtimeOf(this.store.get(id)).hold?.until ?? null;
  }
  /** A viewer looks at device `id`. Returns the function that ends it. */
  watch(id) {
    const runtime = this.runtimeOf(this.store.get(id));
    runtime.viewers++;
    this.signal();
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      runtime.viewers--;
      this.signal();
    };
  }
}
