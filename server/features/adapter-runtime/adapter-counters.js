const GROUPS = ["requests", "upstreamStatus", "errors", "capabilityFallbacks"];
const SCALARS = ["unauthorized", "clientDisconnects"];

/**
 * In-memory counters of one adapter process: names and numbers only, never request,
 * response, key or token content. Groups count by name; scalars are plain totals.
 */
export function createAdapterCounters() {
  const state = Object.fromEntries([
    ...GROUPS.map((group) => [group, {}]),
    ...SCALARS.map((name) => [name, 0]),
  ]);

  function count(group, name) {
    if (!GROUPS.includes(group)) throw new TypeError(`counters: unknown group ${group}`);
    const record = state[group];
    record[name] = (record[name] ?? 0) + 1;
  }

  function increment(name) {
    if (!SCALARS.includes(name)) throw new TypeError(`counters: unknown counter ${name}`);
    state[name] += 1;
  }

  /** Counts an upstream HTTP status by class (`"2xx"`, `"4xx"`, …). */
  const status = (code) => count("upstreamStatus", `${Math.floor(code / 100)}xx`);

  return { count, increment, status, snapshot: () => structuredClone(state) };
}
