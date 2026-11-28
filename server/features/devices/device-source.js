/*
 * A device source is the only code that knows how a device comes to exist and run:
 * the emulator source today (emulator-source.js), a real phone or another backend
 * later. Everything else talks to a device through the source, and to a running
 * device through adb only. `record` is a device record of device-store.js.
 *
 *   availability()             -> null | reason code       why no device can run now
 *   create(record)             -> Promise<void>            files exist afterwards; nothing boots
 *   start(record, { signal })  -> Promise<{ serial, provisioned? }>
 *                                 resolves when booted; `provisioned: true` says
 *                                 that the first-boot steps of a record with
 *                                 `provisioned: false` ran
 *   stop(record)               -> Promise<void>            saves the quick-boot snapshot
 *   reset(record)              -> Promise<{ image }>       factory state on the pinned image
 *   remove(record)             -> Promise<void>
 *   state(record)              -> { state, serial | null } "stopped" | "starting" |
 *                                                          "running" | "stopping"
 *   exec(record, args, options)-> Promise<{ stdout, stderr, code, truncated }>
 *                                 an adb command on the running device (the options
 *                                 of AdbClient#exec); DEVICE_NOT_RUNNING otherwise
 *   ports(record)              -> number[]                 loopback ports of the running device
 *   diskBytes(record)          -> Promise<number>
 *   reclaim(records)           -> Promise<string[]>        ids whose leftover process was stopped
 *   close({ graceMs })         -> Promise<void>            stops every device; bounded
 *
 * A source reports a device that ended by itself while it was running through
 * `source.onExit = (id, { code, signal }) => {}`. An exit that answers a `start`
 * (rejected with DEVICE_EXITED) or a `stop` is not reported there.
 *
 * Refusals are errors with a stable `code` and an HTTP `status` (409):
 * DEVICE_UNAVAILABLE (with `reason`: a host code, DEVICES_NOT_INSTALLED,
 * DEVICES_OPERATION_RUNNING while the SDK is installed, updated or removed, or
 * DEVICES_SHUTTING_DOWN), DEVICE_IMAGE_MISSING (with `image`: the system image a
 * device needs is not installed), DEVICE_PORTS_BUSY, DEVICE_ADB_FAILED (with
 * `reason` DEVICE_ADB_PORT_IN_USE when the adb port is another program's),
 * DEVICE_ADB_TIMEOUT, DEVICE_ADB_CANCELLED, DEVICE_BOOT_TIMEOUT, DEVICE_EXITED (with
 * `exitCode`), DEVICE_START_CANCELLED, DEVICE_STOP_FAILED, DEVICE_BUSY (a start
 * while the device stops), DEVICE_NOT_RUNNING and DEVICE_DISK_SPACE.
 */
export const SOURCE_METHODS = Object.freeze([
  "availability",
  "create",
  "start",
  "stop",
  "reset",
  "remove",
  "state",
  "exec",
  "ports",
  "diskBytes",
  "reclaim",
  "close",
]);

/** A refusal with a stable `code`, an HTTP `status` (409) and further fields. */
export function deviceError(code, extra = {}) {
  return Object.assign(Error(code), { code, status: 409, ...extra });
}

/** Throws unless `source` has every method of the contract above. Returns it. */
export function assertSource(source) {
  const missing = SOURCE_METHODS.filter((name) => typeof source?.[name] !== "function");
  if (missing.length)
    throw TypeError(`A device source lacks: ${missing.join(", ") || "everything"}.`);
  return source;
}
