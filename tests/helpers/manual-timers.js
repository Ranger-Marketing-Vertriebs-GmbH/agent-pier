// Manual timers for code that takes `timers = { setTimeout, clearTimeout }`: time only
// moves through `advance`, which fires due callbacks in order and settles promises
// between them, so async reads started by a timer finish before the next one fires.
const settle = () => new Promise((resolve) => setImmediate(resolve));

export function manualTimers() {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  const timers = {
    setTimeout(callback, ms = 0) {
      const handle = { id: ++sequence, unref() {} };
      pending.set(handle, { at: now + Math.max(0, ms), callback, id: handle.id });
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
  };
  const due = (end) =>
    [...pending]
      .filter(([, timer]) => timer.at <= end)
      .sort(([, a], [, b]) => a.at - b.at || a.id - b.id)[0];
  return {
    timers,
    now: () => now,
    pending: () => pending.size,
    settle,
    /** Moves time forward by `ms`, firing every timer due on the way. */
    async advance(ms) {
      const end = now + ms;
      await settle();
      for (let next = due(end); next; next = due(end)) {
        const [handle, timer] = next;
        pending.delete(handle);
        now = timer.at;
        timer.callback();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}
