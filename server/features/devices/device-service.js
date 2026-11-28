import { SyncQueue } from "../../lib/sync-queue.js";
import { admit } from "./device-admission.js";
import { DeviceRegistry, refusal } from "./device-registry.js";
import { failureOf } from "./device-runtime.js";

/*
 * Android devices as the rest of AgentPier uses them. This is their lifecycle:
 * create, start, stop, reset, delete, adb calls, the idle stop, and what happens at
 * server start and at shutdown. The records, the limits, the view, the owner's hold
 * and the rule of who may use or manage a device are the registry's
 * (device-registry.js), which this class extends. How a device exists and runs is
 * its source's business (device-source.js); the service talks to a running device
 * through `adb()` only.
 *
 * State lives in memory (device-runtime.js): a device is `stopped`, `starting`,
 * `running`, `stopping` or `failed` (with `failure: { code, at, reason? }`); after a
 * restart nothing runs, because `start()` lets the sources reclaim what an earlier
 * process left. Every call waits for that reclaim (`ready`), so nothing boots beside
 * it.
 *
 * Two kinds of queue keep it orderly:
 * - one queue for the whole service on which every decision about the limits is
 *   taken (a start reserves its slot there before it boots), so two starts never
 *   both see the last free slot;
 * - one queue per device, on which its lifecycle operations and adb calls run one
 *   after another. A stop, reset or delete does not wait for a boot on that queue:
 *   it aborts the boot and then takes its turn.
 *
 * While every device is removed for an uninstall (`removeAll`), no call and no
 * create begins; and that removal begins only while no device runs, has an
 * operation or has calls waiting.
 *
 * Refusals carry a stable `code` and an HTTP `status`.
 */
export class DeviceService extends DeviceRegistry {
  /**
   * The options of DeviceRegistry, and:
   *
   * - `idleMs`: a running device stops after this long without a call, or after
   *   `idleCapMs` while it is viewed or held; `busyMs`: how long after a call a device
   *   counts as in use; `sweepMs`: how often the idle stop looks.
   */
  constructor({
    idleMs = 900000,
    idleCapMs = 3600000,
    busyMs = 300000,
    sweepMs = 60000,
    ...registry
  }) {
    super(registry);
    Object.assign(this, { idleMs, idleCapMs, busyMs, sweepMs });
    for (const source of Object.values(this.sources))
      source.onExit = (id, result) => this.#exited(id, result);
    this.admission = new SyncQueue();
    this.sweepTimer = null;
    this.closed = false;
    // Settles when the reclaim of start() is over; every call waits for it.
    this.ready = Promise.resolve();
    // Every device is being removed for an uninstall.
    this.removing = false;
  }
  #enqueue(runtime, task) {
    runtime.pending++;
    return runtime.queue
      .run(async () => {
        await this.ready;
        return task();
      })
      .finally(() => runtime.pending--);
  }
  // Nothing begins while every device is being removed.
  #open() {
    if (this.removing)
      throw refusal("DEVICE_UNAVAILABLE", 409, { reason: "DEVICES_OPERATION_RUNNING" });
  }
  #usable() {
    const reason = this.closed ? "DEVICES_SHUTTING_DOWN" : this.availability();
    if (reason) throw refusal("DEVICE_UNAVAILABLE", 409, { reason });
  }
  // While the owner holds a device, nobody else acts on it.
  #free(runtime, caller) {
    if (runtime.hold && caller?.kind !== "owner") throw refusal("DEVICE_HELD");
  }
  // Checks `caller`, an uninstall, the hold and a running reset or delete. Returns
  // the runtime.
  #enter(id, caller, need, { held = true } = {}) {
    if (!this.permission(caller, id)[need]) throw refusal("DEVICE_FORBIDDEN", 403);
    this.#open();
    const runtime = this.runtimeOf(this.store.get(id));
    if (held) this.#free(runtime, caller);
    if (runtime.operation) throw refusal("DEVICE_BUSY");
    return runtime;
  }
  // At a call's turn on the device's queue: the owner may have taken the device
  // away from the caller, or for themselves, while the call waited.
  #turn(id, caller, need, runtime, { held = true } = {}) {
    if (!this.permission(caller, id)[need]) throw refusal("DEVICE_FORBIDDEN", 403);
    if (held) this.#free(runtime, caller);
  }

  /**
   * Creates a device for `creator` (`{ kind, id, name }`) and returns its view;
   * nothing boots. Throws DEVICE_UNAVAILABLE (with `reason`;
   * DEVICES_OPERATION_RUNNING while every device is removed), DEVICE_LIMIT_TOTAL,
   * DEVICE_NAME_INVALID (400), DEVICE_NAME_TAKEN or a refusal of the source.
   */
  async create({ name, creator, source = "emulator" }) {
    this.#open();
    return this.admission.run(async () => {
      await this.ready;
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
        await this.sourceOf(record).create(record);
      } catch (error) {
        this.store.remove(record.id);
        throw error;
      }
      this.runtimeOf(record);
      await this.measure(record);
      this.audited("device.created", record, record.creator);
      this.signal();
      return this.device(record.id);
    });
  }
  // Takes a running slot for device `id`, stopping an idle device when none is free.
  // `signal` is the boot's: a start that was aborted while it waited takes none.
  async #admit(id, signal) {
    const cancelled = () => {
      if (signal.aborted) throw refusal("DEVICE_START_CANCELLED");
    };
    cancelled();
    this.#usable();
    for (;;) {
      const decision = admit({
        running: this.running(),
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
      const victim = this.runtimeOf(this.store.get(decision.evict));
      await this.#enqueue(victim, () => this.#stop(decision.evict)).catch(() => {
        throw refusal("DEVICE_LIMIT_RUNNING");
      });
    }
    cancelled();
    // The device may be gone by now: DEVICE_NOT_FOUND then.
    const runtime = this.runtimeOf(this.store.get(id));
    runtime.state = "starting";
    runtime.failure = null;
    this.signal();
  }
  // On the device's queue: boots it unless it runs.
  async #boot(id) {
    const record = this.store.get(id);
    const runtime = this.runtimeOf(record);
    if (runtime.state === "running") return;
    const boot = new AbortController();
    runtime.boot = boot;
    try {
      await this.admission.run(() => this.#admit(id, boot.signal));
      try {
        const { signal } = boot;
        const started = await this.sourceOf(record).start(record, { signal });
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
          : failureOf(error, "DEVICE_START_FAILED", this.now());
        throw error;
      } finally {
        this.signal();
      }
    } finally {
      if (runtime.boot === boot) runtime.boot = null;
    }
  }
  // On the device's queue: stops it, whatever state it is in.
  async #stop(id) {
    const record = this.store.get(id);
    const runtime = this.runtimeOf(record);
    if (runtime.state === "stopped") return;
    runtime.state = "stopping";
    this.signal();
    let failure = null;
    try {
      await this.sourceOf(record).stop(record);
    } catch (error) {
      failure = failureOf(error, "DEVICE_STOP_FAILED", this.now());
      throw error;
    } finally {
      if (runtime.lastUse !== record.lastUsedAt)
        this.store.patch(id, { lastUsedAt: runtime.lastUse });
      await this.measure(record);
      // Last of all: whoever sees the device stopped finds nothing of this stop
      // left on its queue (an uninstall would be refused while there is).
      runtime.state = failure ? "failed" : "stopped";
      runtime.failure = failure;
      this.signal();
    }
  }
  /**
   * Starts device `id` and resolves its view once it runs. Throws
   * DEVICE_LIMIT_RUNNING when every slot is taken by a device in use, DEVICE_BUSY,
   * DEVICE_FORBIDDEN (403), DEVICE_UNAVAILABLE or the source's start failure.
   */
  async startDevice(id, { caller } = {}) {
    const runtime = this.#enter(id, caller, "use", { held: false });
    await this.#enqueue(runtime, () => {
      this.#turn(id, caller, "use", runtime, { held: false });
      return this.#boot(id);
    });
    return this.device(id);
  }
  /**
   * Stops device `id` after the calls that wait for it; a boot in progress is
   * aborted (its start rejects with DEVICE_START_CANCELLED). A device whose earlier
   * stop failed is stopped again. Resolves its view.
   */
  async stopDevice(id, { caller } = {}) {
    const runtime = this.#enter(id, caller, "use");
    runtime.boot?.abort();
    await this.#enqueue(runtime, () => {
      this.#turn(id, caller, "use", runtime);
      return this.#stop(id);
    });
    return this.device(id);
  }
  // A reset or delete: announced at once, run on the device's queue. A boot in
  // progress is aborted for it.
  async #operate(id, caller, operation, work) {
    const runtime = this.#enter(id, caller, "manage");
    runtime.boot?.abort();
    runtime.operation = operation;
    this.signal();
    try {
      return await this.#enqueue(runtime, () => {
        this.#turn(id, caller, "manage", runtime);
        return work(this.store.get(id), runtime);
      });
    } finally {
      runtime.operation = null;
      this.signal();
    }
  }
  // After a source operation that stops the device itself.
  #settle(record, runtime) {
    const { state } = this.sourceOf(record).state(record);
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
        const { image } = await this.sourceOf(record).reset(record);
        this.store.patch(id, { image, provisioned: false, resetAt: this.now() });
        this.audited("device.reset", record, caller);
      } finally {
        this.#settle(record, runtime);
        await this.measure(record);
      }
    });
    return this.device(id);
  }
  /** Deletes device `id` with everything on it. Needs `manage`. */
  async remove(id, { caller } = {}) {
    await this.#operate(id, caller, "delete", async (record, runtime) => {
      try {
        await this.sourceOf(record).remove(record);
      } catch (error) {
        this.#settle(record, runtime);
        throw error;
      }
      this.forget(record);
      this.audited("device.deleted", record, caller);
    });
  }
  // Throws while a device holds a slot, has an operation, or has calls that wait.
  #idle() {
    if (this.inUse()) throw refusal("DEVICES_IN_USE");
    for (const runtime of this.runtimes.values())
      if (runtime.operation || runtime.pending) throw refusal("DEVICE_BUSY");
  }
  /**
   * Deletes every device, before the SDK is removed. Throws DEVICES_IN_USE while one
   * runs, starts or stops, DEVICE_BUSY while one is reset or deleted or has calls
   * waiting, and DEVICE_UNAVAILABLE (`reason` DEVICES_OPERATION_RUNNING) while
   * another removal runs. Until it is over, every call on a device and every create
   * is refused with that DEVICE_UNAVAILABLE.
   */
  async removeAll() {
    this.#open();
    this.#idle();
    this.removing = true;
    try {
      await this.admission.run(async () => {
        await this.ready;
        // A create that waited before this one may have added a device; nothing else
        // began since.
        this.#idle();
        for (const record of this.store.list()) {
          await this.sourceOf(record).remove(record);
          this.forget(record);
          this.audited("device.deleted", record, { kind: "owner" });
        }
      });
    } finally {
      this.removing = false;
      this.signal();
    }
  }
  /**
   * Runs `adb <args>` on device `id`, after the calls that wait for it, and resolves
   * `{ stdout, stderr, code, truncated }`. A stopped device is started first unless
   * `start` is false (DEVICE_NOT_RUNNING then). Throws DEVICE_HELD while the owner
   * holds the device and the caller is someone else, DEVICE_BUSY during a reset or
   * delete, DEVICE_FORBIDDEN (403), DEVICE_ADB_CANCELLED when `signal` has aborted
   * by the call's turn, or what the start throws. The grant and the hold are checked
   * when the call arrives and again at its turn, as for a start, stop, reset and
   * delete. The other options are
   * AdbClient#exec's: `timeoutMs`, `maxBytes`, `input`, `signal`, `encoding`.
   */
  async adb(id, args, { caller, start = true, ...options } = {}) {
    const runtime = this.#enter(id, caller, "use");
    return this.#enqueue(runtime, async () => {
      this.#turn(id, caller, "use", runtime);
      const record = this.store.get(id);
      // A caller that is gone, or whose call ended at its deadline while it waited,
      // starts no device and runs nothing.
      if (options.signal?.aborted) throw refusal("DEVICE_ADB_CANCELLED");
      if (runtime.state !== "running") {
        if (!start) throw refusal("DEVICE_NOT_RUNNING");
        await this.#boot(id);
      }
      runtime.lastUse = this.now();
      try {
        return await this.sourceOf(record).exec(record, args, options);
      } finally {
        runtime.lastUse = this.now();
      }
    });
  }

  #exited(id) {
    const runtime = this.runtimes.get(id);
    if (runtime?.state !== "running") return;
    runtime.state = "failed";
    runtime.failure = { code: "DEVICE_EXITED", at: this.now() };
    this.signal();
  }
  /** Stops every running device that was not used for too long. */
  async sweep() {
    const now = this.now();
    await Promise.all(
      this.store.list().map((record) => {
        const runtime = this.runtimeOf(record);
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
   * At server start: the sources stop what an earlier process left running; then the
   * idle stop begins. Never throws. The routes are mounted by then, so calls may
   * arrive meanwhile: each waits until the leftovers are gone (`ready`), and what it
   * starts afterwards is not touched here.
   */
  async start() {
    const earlier = this.ready;
    const reclaim = async () => {
      await earlier;
      const records = this.store.list();
      for (const [name, source] of Object.entries(this.sources))
        try {
          await source.reclaim(records.filter((record) => record.source === name));
        } catch (error) {
          // The calls that wait go on all the same.
          console.warn(`Android devices: reclaim failed (${error?.code || "unknown"}).`);
        }
      return records;
    };
    const reclaimed = reclaim();
    this.ready = reclaimed.then(() => {});
    const records = await reclaimed;
    // No state is set here: a new process knows every device as stopped, and what a
    // source did not reclaim (a device this very process runs) keeps its slot.
    for (const record of records) this.runtimeOf(record);
    await Promise.all(records.map((record) => this.measure(record)));
    this.#schedule();
    this.signal();
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
