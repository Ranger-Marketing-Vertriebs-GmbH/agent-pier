// The native update contracts run a real Gateway through a whole activation. When one
// runs out of time, node:test only says "timed out"; this names the update journal's
// phase (runtime-updates.js) and the test's own step it stalled in, with the time each
// was reached, and fails before the test's own timeout so cleanup still runs.

/** Records the phases `updates` passes and the steps the test marks. */
export function updateTrail(updates) {
  const began = Date.now();
  const entries = [];
  const add = (name) => {
    if (entries.at(-1)?.name !== name) entries.push({ name, at: Date.now() - began });
  };
  const changed = updates.onChange;
  updates.onChange = () => {
    changed?.();
    add(`phase:${updates.journal.phase}`);
  };
  return {
    /** A step of the test itself (a maintenance hook, a start). */
    mark: (step) => add(step),
    describe: () =>
      entries.map(({ name, at }) => `${name} @${(at / 1000).toFixed(1)}s`).join(" -> ") ||
      "nothing yet",
  };
}

/**
 * Runs `steps()` and rejects after `ms` with the trail so far, naming where it
 * stalled. The steps go on in the background; the test's cleanup stops the Gateway.
 */
export async function withinTrail(ms, trail, steps) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          Error(`Native update did not finish within ${ms} ms: ${trail.describe()}`),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([steps(), expired]);
  } finally {
    clearTimeout(timer);
  }
}
