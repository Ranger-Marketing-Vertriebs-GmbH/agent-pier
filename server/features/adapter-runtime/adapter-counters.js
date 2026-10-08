const GROUPS = ["requests", "upstreamStatus", "errors"];
const OUTCOMES = ["kept", "reverted"];
const SCALARS = ["unauthorized", "forbidden", "clientDisconnects", "shutdownAborts"];

/**
 * In-memory counters of one adapter process: names and numbers only, never request,
 * response, key or token content. Groups count by name; scalars are plain totals.
 */
export function createAdapterCounters() {
  const state = Object.fromEntries([
    ...GROUPS.map((group) => [group, {}]),
    ...SCALARS.map((name) => [name, 0]),
    ["capabilityFallbacks", {}],
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

  /** Counts a capability retry (`"<name>=<value>"`) as `kept` or `reverted`. */
  function fallback(name, outcome) {
    if (!OUTCOMES.includes(outcome))
      throw new TypeError(`counters: unknown outcome ${outcome}`);
    const record = (state.capabilityFallbacks[name] ??= { kept: 0, reverted: 0 });
    record[outcome] += 1;
  }

  return { count, increment, status, fallback, snapshot: () => structuredClone(state) };
}

const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const counted = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Adds the counters of a previous snapshot (`base`, read back from the diagnostics file
 * after a crash restart) to the current ones: numbers are summed, objects merged by name.
 * Anything in `base` that is not a non-negative number or a plain object is ignored.
 */
export function addCounts(base, current, depth = 0) {
  if (counted(base) || counted(current))
    return (counted(base) ? base : 0) + (counted(current) ? current : 0);
  if (depth > 3 || (!plain(base) && !plain(current))) return current;
  const a = plain(base) ? base : {};
  const b = plain(current) ? current : {};
  const out = {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (name === "__proto__") continue;
    const value = addCounts(a[name], b[name], depth + 1);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
