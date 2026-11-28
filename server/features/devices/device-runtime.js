import { SyncQueue } from "../../lib/sync-queue.js";

/*
 * What the device service (device-service.js) knows about one device in memory, and
 * how a device looks to everyone else: the view `GET /api/devices` answers and the
 * `devices` topic carries.
 */

/** The states in which a device holds a running slot. */
export const slots = Object.freeze(["starting", "running", "stopping"]);

/**
 * The runtime of the device of `record`:
 *
 * - `state`: `stopped`, `starting`, `running`, `stopping` or `failed`, with
 *   `failure: { code, at, reason? }` while it is `failed`
 * - `operation`: `reset` or `delete` while one is announced or runs
 * - `boot`: the AbortController of the boot in progress; a stop, reset or delete
 *   aborts it instead of waiting for the boot
 * - `queue` and `pending`: the device's own queue, and how many calls and operations
 *   run or wait on it
 * - `lastUse`, `viewers`, `hold`: what keeps the device from the idle stop and from
 *   being stopped for another
 * - `diskBytes`: its size as last measured, or null
 */
export function newRuntime(record) {
  return {
    state: "stopped",
    operation: null,
    failure: null,
    boot: null,
    lastUse: record.lastUsedAt,
    viewers: 0,
    hold: null,
    queue: new SyncQueue(),
    pending: 0,
    diskBytes: null,
  };
}

/**
 * The failure of a device whose start or stop threw `error`: its stable code, or
 * `fallback`, the time, and the `reason` code a refusal carried (why devices are
 * unavailable, or that the adb port is another program's).
 */
export function failureOf(error, fallback, at) {
  const stable = (value) =>
    typeof value === "string" && /^DEVICES?_[A-Z0-9_]+$/.test(value);
  return {
    code: stable(error?.code) ? error.code : fallback,
    at,
    ...(stable(error?.reason) && { reason: error.reason }),
  };
}

/**
 * The view of one device.
 *
 * - `live`: the source still has a process for it. True in every slot state, and for
 *   a `failed` device whose stop did not end the process: such a device can be
 *   stopped again and still counts as running.
 * - `creator.gone`: the agent or session that created it no longer exists.
 * - `image.current`: false when a later release pinned another image (a reset moves
 *   the device to it).
 * - `diskBytes`: measured at start-up and after create, stop and reset.
 */
export function deviceView(record, runtime, { live, gone, assignments, pinned }) {
  return {
    id: record.id,
    name: record.name,
    source: record.source,
    state: runtime.state,
    operation: runtime.operation,
    failure: runtime.failure,
    live,
    creator: { ...record.creator, gone },
    assignments,
    image: { id: record.image, current: record.image === pinned },
    diskBytes: runtime.diskBytes,
    held: !!runtime.hold,
    viewers: runtime.viewers,
    createdAt: record.createdAt,
    lastUsedAt: runtime.lastUse,
  };
}
