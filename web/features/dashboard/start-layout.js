// What the start page showed last time (tests/unit/start-layout.test.js), so its
// skeletons take the shape of the last loaded page and nothing moves when the data
// arrives: whether agents are on, how many items need you, how many sessions, agents,
// runs and tools there were. Counts only, kept per browser; a first visit (or storage
// that refuses access) starts from the defaults.

const KEY = "agentpier.start.layout";
const MAX = 999;

export const startLayoutDefaults = Object.freeze({
  agents: true,
  attention: 0,
  // `items`: every entry of the list; `rows`: those under the preselected chip.
  sessions: Object.freeze({ items: 3, rows: 3 }),
  agentList: Object.freeze({ items: 3, rows: 3 }),
  runs: 1,
  tools: 4,
});

const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? Math.min(value, MAX) : undefined;

function list(value) {
  const items = count(value?.items);
  const rows = count(value?.rows);
  return items === undefined || rows === undefined
    ? undefined
    : { items, rows: Math.min(rows, items) };
}

/** Only the known, well-formed parts of `value`; anything else is dropped. */
export function cleanStartLayout(value) {
  if (!value || typeof value !== "object") return {};
  const clean = {
    agents: typeof value.agents === "boolean" ? value.agents : undefined,
    attention: count(value.attention),
    sessions: list(value.sessions),
    agentList: list(value.agentList),
    runs: count(value.runs),
    tools: count(value.tools),
  };
  return Object.fromEntries(
    Object.entries(clean).filter(([, entry]) => entry !== undefined),
  );
}

function storageOf(storage) {
  try {
    return storage === undefined ? globalThis.localStorage : storage;
  } catch {
    return null;
  }
}

function readStored(storage) {
  try {
    return cleanStartLayout(JSON.parse(storageOf(storage)?.getItem(KEY) || "null"));
  } catch {
    return {};
  }
}

/** The remembered layout over the defaults. */
export function readStartLayout(storage) {
  return { ...startLayoutDefaults, ...readStored(storage) };
}

/**
 * Stores the known parts of `next` over what is stored; unknown parts keep their
 * last value. Writes only on a change. Returns the stored layout.
 */
export function rememberStartLayout(next, storage) {
  const stored = readStored(storage);
  const merged = { ...stored, ...cleanStartLayout(next) };
  if (JSON.stringify(merged) !== JSON.stringify(stored))
    try {
      storageOf(storage)?.setItem(KEY, JSON.stringify(merged));
    } catch {
      // Storage refused: the next visit starts from the defaults.
    }
  return merged;
}
