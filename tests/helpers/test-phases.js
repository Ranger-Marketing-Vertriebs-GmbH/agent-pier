// Marks the steps of a long native test as diagnostics with the time each began.
// node:test prints a test's diagnostics even when it times out, so a timeout names
// the step it was in and how long the steps before it took: on a slow runner every
// step is slow, a hang leaves one step that never ended.
export function testPhases(t) {
  const started = performance.now();
  return (name) =>
    t.diagnostic(`${name} at ${((performance.now() - started) / 1000).toFixed(1)} s`);
}
