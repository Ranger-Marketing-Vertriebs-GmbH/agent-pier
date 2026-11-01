// OpenClaw 2026.9.8 answers a config write once the file is persisted; its runtime
// config, the one a new run resolves model and auth profile from, commits in a
// separately scheduled reload afterwards and is announced with `config.changed`
// (carrying the persisted hash). A run started before that commit still sees the
// previous config. The event is broadcast with dropIfSlow and only when the effective
// config changed, so a missing event ends the wait after a bounded time, not in an error.
// OpenClaw also announces a write it accepted without applying it to the runtime
// (hot reload off, a restart pending), so "adopted" is best effort in those modes.
export const configAdoptionTimeoutMs = 5000;

/**
 * Watches `config.changed` from before the first write. Callers `mark()` right before
 * each config write; `settle(base, written)` after the last one then waits until the
 * Gateway announced `written`, or announced anything other than `base` since the last
 * mark (a later write coalesced into the same reload, or an event without a hash). It
 * returns at once when nothing changed (`written === base`) or the client cannot
 * deliver events. `close()` ends the subscription and must always run.
 */
export function watchConfigAdoption(
  client,
  { timeoutMs = configAdoptionTimeoutMs, warn = console.warn } = {},
) {
  const seen = new Set();
  let sinceMark = [];
  let wake = null;
  const unsubscribe =
    typeof client?.subscribe === "function"
      ? client.subscribe((frame) => {
          if (frame?.event !== "config.changed") return;
          const hash = frame.payload?.hash ?? null;
          seen.add(hash);
          sinceMark.push(hash);
          wake?.();
        })
      : null;
  return {
    // Without events there is nothing to wait for, so no baseline is needed either.
    watching: !!unsubscribe,
    mark() {
      sinceMark = [];
    },
    async settle(base, written) {
      if (!unsubscribe || !written || written === base) return true;
      const adopted = () =>
        seen.has(written) || sinceMark.some((hash) => hash === null || hash !== base);
      if (adopted()) return true;
      let timer;
      const confirmed = await new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        wake = () => adopted() && resolve(true);
      }).finally(() => {
        clearTimeout(timer);
        wake = null;
      });
      if (!confirmed)
        warn(
          `Assistant Gateway did not announce the adoption of the written configuration within ${timeoutMs} ms; continuing.`,
        );
      return confirmed;
    },
    close() {
      wake = null;
      unsubscribe?.();
    },
  };
}
