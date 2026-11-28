/*
 * Whether one more device may run, and which running device makes room for it: the
 * pure decision behind the limit of devices running at once (device-service.js
 * takes it on one queue for all devices, so two starts never decide at once).
 *
 * `running` are the devices that hold a slot, `[{ id, state, lastUse, viewers, held,
 * queued }]`: every device that starts, runs or stops. One of them can be stopped
 * for another when it is `running`, the owner does not hold it, no call on it runs
 * or waits (`queued`), it was last used at least `busyMs` ago, and nobody views it;
 * a view keeps a device at most `idleCapMs` after its last use, as it does against
 * the idle stop. Of several, the least recently used goes.
 */
export function admit({ running, limit, now, busyMs, idleCapMs, wanted }) {
  if (running.some((device) => device.id === wanted)) return { ok: true, evict: null };
  if (running.length < limit) return { ok: true, evict: null };
  const idle = running
    .filter((device) => {
      const unused = now - device.lastUse;
      return (
        device.state === "running" &&
        !device.held &&
        !device.queued &&
        unused >= busyMs &&
        (!device.viewers || unused >= idleCapMs)
      );
    })
    .sort((a, b) => a.lastUse - b.lastUse);
  return idle.length
    ? { ok: true, evict: idle[0].id }
    : { ok: false, code: "DEVICE_LIMIT_RUNNING" };
}
