// A fake browser for `startVisiblePolling`'s `env`: a document whose `hidden` flag
// the test sets, a window for pageshow/online, and manual timers.
export function fakeEnv({ hidden = false } = {}) {
  const document = new EventTarget();
  document.hidden = hidden;
  const window = new EventTarget();
  let now = 0,
    nextId = 1;
  const timers = new Map();
  const env = {
    document,
    window,
    AbortController,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return {
    env,
    timers,
    setHidden(value) {
      document.hidden = value;
      document.dispatchEvent(new Event("visibilitychange"));
    },
    // Fires due timers in order and lets each run's promise settle before the next.
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        await settle();
        const due = [...timers].filter(([, timer]) => timer.at <= until);
        if (!due.length) break;
        due.sort((a, b) => a[1].at - b[1].at);
        const [id, timer] = due[0];
        timers.delete(id);
        now = timer.at;
        timer.callback();
      }
      now = until;
      await settle();
    },
  };
}

export const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
