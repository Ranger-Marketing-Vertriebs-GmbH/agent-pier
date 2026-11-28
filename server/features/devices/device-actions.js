import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { appActions } from "./device-app-actions.js";
import { devicePaths } from "./device-paths.js";
import { refusal } from "./device-registry.js";
import { screenActions } from "./device-screen-actions.js";

/*
 * What an agent or a coding session does with a device, as one set of actions that
 * is independent of how the caller reached AgentPier: the session tools
 * (device-mcp.js) call it today, the agent tools will. An action is a name, an
 * input object and a context:
 *
 *   run(action, input, { caller, canCreate, area, signal })
 *
 * - `caller`: `{ kind: "session" | "agent", id, name }`. Who may use, reset or
 *   delete which device is the device service's rule (device-access.js); every
 *   action goes through it, so a device without a grant answers DEVICE_FORBIDDEN and
 *   one the owner holds DEVICE_HELD.
 * - `canCreate()`: whether the caller may create devices (DEVICE_CREATE_FORBIDDEN).
 * - `area()`: resolves the caller's own folder on the host, for files that travel
 *   to or from a device (host-area.js); null when it has none.
 * - `signal`: aborts the call when the caller is gone.
 *
 * The actions (ACTIONS) and their inputs are documented where they are defined:
 * device-screen-actions.js (list, create, start, stop, reset, delete, screenshot,
 * ui, tap, swipe, key, type) and device-app-actions.js (install, push, pull,
 * app_launch, app_stop, apps, open_url, logs, shell).
 *
 * What every action keeps to:
 * - It talks to the device through `DeviceService#adb` only, which queues the calls
 *   of one device, starts a stopped device and waits for its boot.
 * - No host shell is involved: adb gets an argument array, and what is meant for
 *   the device's shell is one checked or quoted string (device-input.js).
 * - Its result is bounded, and a refusal carries a stable code and at most a short
 *   `detail`; adb's own output is never thrown as it is.
 * - It ends after `callTimeoutMs` with DEVICE_CALL_TIMEOUT, before the tool call
 *   that carries it would time out; a boot that takes longer goes on, and the next
 *   call finds the device running.
 *
 * The numbering of a device's last UI overview is remembered per caller, so a tap
 * can name an element by its number. It is forgotten as soon as the device is no
 * longer running or is reset or removed: a number from before a restart is refused
 * with DEVICE_ELEMENT_STALE, and so is one without any overview.
 */
export const ACTION_LIMITS = Object.freeze({
  // A file to the device (an APK too), and a file from the device.
  pushBytes: 200 * 2 ** 20,
  pullBytes: 50 * 2 ** 20,
  screenshotBytes: 4 * 2 ** 20,
  // Output of a shell command and of the logs, and what a refusal quotes of adb.
  outputBytes: 65536,
  errorBytes: 16384,
  shellTimeoutMs: 30000,
  shellTimeoutMaxMs: 120000,
  logLines: 100,
  logLinesMax: 1000,
  apps: 500,
  overviews: 200,
});

const handlers = Object.freeze({ ...screenActions, ...appActions });
export const ACTIONS = Object.freeze(Object.keys(handlers));

export class DeviceActions {
  /**
   * `devices` is the DeviceService; `dataDir` AgentPier's data folder, which holds
   * the private copies of travelling files and is itself no part of any area.
   */
  constructor({ devices, dataDir, callTimeoutMs = 140000, limits = ACTION_LIMITS }) {
    Object.assign(this, { devices, dataDir, callTimeoutMs, limits });
    this.transfers = path.join(devicePaths(dataDir).run, "transfers");
    // What an earlier process left of a transfer it did not finish.
    fs.rmSync(this.transfers, { recursive: true, force: true });
    // "<kind>:<caller id>:<device id>" -> the targets of that caller's last overview.
    this.overviews = new Map();
    devices.onChanged(() => this.#expire());
    devices.onRemoved((id) => this.#forget(id));
  }
  #forget(deviceId) {
    for (const key of this.overviews.keys())
      if (key.endsWith(`:${deviceId}`)) this.overviews.delete(key);
  }
  // An overview is of the screen of one run of a device.
  #expire() {
    for (const id of new Set([...this.overviews.keys()].map((key) => key.split(":")[2])))
      try {
        const { state, operation } = this.devices.device(id);
        if (state !== "running" || operation) this.#forget(id);
      } catch {
        this.#forget(id);
      }
  }
  #key(caller, deviceId) {
    return `${caller.kind}:${caller.id}:${deviceId}`;
  }
  /** Remembers `targets` (`[{ n, x, y }]`) as `caller`'s overview of the device. */
  remember(caller, deviceId, targets) {
    const key = this.#key(caller, deviceId);
    this.overviews.delete(key);
    this.overviews.set(key, targets);
    while (this.overviews.size > this.limits.overviews)
      this.overviews.delete(this.overviews.keys().next().value);
    // The device may have stopped while its screen was read.
    this.#expire();
  }
  /** The point of element `n` of `caller`'s last overview. DEVICE_ELEMENT_STALE. */
  target(caller, deviceId, n) {
    const found = this.overviews
      .get(this.#key(caller, deviceId))
      ?.find((entry) => entry.n === n);
    if (!found) throw refusal("DEVICE_ELEMENT_STALE");
    return { x: found.x, y: found.y };
  }
  /**
   * The device `reference` (its id or its name) among those `caller` may use.
   * Throws DEVICE_FORBIDDEN (403) for a device that exists without a grant, and
   * DEVICE_NOT_FOUND (404).
   */
  device(caller, reference) {
    if (typeof reference !== "string" || !reference || reference.length > 100)
      throw refusal("DEVICE_NOT_FOUND", 404);
    const mine = this.devices.devicesFor(caller);
    const found =
      mine.find((device) => device.id === reference) ??
      mine.find((device) => device.name === reference);
    if (found) return found;
    // Throws DEVICE_NOT_FOUND for an id nobody has.
    this.devices.permission(caller, reference);
    throw refusal("DEVICE_FORBIDDEN", 403);
  }
  /**
   * Runs `work(folder)` with a new private folder for the copies of one transfer
   * and removes it afterwards, whatever happened.
   */
  async staged(work) {
    const folder = path.join(this.transfers, randomBytes(12).toString("hex"));
    fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
    try {
      return await work(folder);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }

  /**
   * Runs `action` with `input` for the caller of `context` and resolves its result
   * (a plain object; `screenshot` answers `{ image: Buffer, mimeType, width,
   * height }`). Throws a refusal with a stable code and status.
   */
  async run(action, input, context) {
    const handler = Object.hasOwn(handlers, action) ? handlers[action] : null;
    const caller = context?.caller;
    if (!handler || !["session", "agent"].includes(caller?.kind) || !caller.id)
      throw refusal("DEVICE_FORBIDDEN", 403);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (context.signal?.aborted) abort();
    context.signal?.addEventListener("abort", abort, { once: true });
    let timer;
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(refusal("DEVICE_CALL_TIMEOUT"));
        abort();
      }, this.callTimeoutMs);
    });
    const { signal } = controller;
    const adb = (id, args, options = {}) =>
      this.devices.adb(id, args, { caller, signal, ...options });
    const call = {
      actions: this,
      devices: this.devices,
      limits: this.limits,
      protectedRoots: [this.dataDir],
      caller,
      signal,
      canCreate: () => !!context.canCreate?.(),
      area: async () => (await context.area?.()) || null,
      device: (reference) => this.device(caller, reference),
      adb,
      shell: (id, command, options) => adb(id, ["shell", command], options),
    };
    const work = Promise.resolve().then(() =>
      handler(input && typeof input === "object" ? input : {}, call),
    );
    // Its end after the deadline is nobody's to hear.
    work.catch(() => {});
    try {
      return await Promise.race([work, late]);
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", abort);
    }
  }
}
