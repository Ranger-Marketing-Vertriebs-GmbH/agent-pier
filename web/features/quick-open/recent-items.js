// The search's recent results: the ids of the last results opened in this browser,
// newest first, per person (`scope`: "owner" or "user:<id>"). Only ids are kept, never
// labels, and a recent id shows only while the person's own index still holds it, so a
// deleted session or an agent taken away never reappears and nothing crosses people.

export const recentLimit = 8;
const prefix = "agentpier-search-recent";
const maxIdLength = 200;

/** The storage key of a person's recent results. */
export const recentKey = (scope) => `${prefix}:${scope || "owner"}`;

const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Storage blocked (private mode, sandboxed frame): no recent results.
    return null;
  }
};

const clean = (ids) =>
  (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === "string" && id && id.length <= maxIdLength)
    .filter((id, at, all) => all.indexOf(id) === at)
    .slice(0, recentLimit);

/** The recent ids of `scope`, newest first; empty when none or unreadable. */
export function readRecent(scope, storage = defaultStorage()) {
  try {
    return clean(JSON.parse(storage?.getItem(recentKey(scope)) || "[]"));
  } catch {
    return [];
  }
}

/** Puts `id` first in the recent results of `scope` and returns the new list. */
export function rememberRecent(scope, id, storage = defaultStorage()) {
  const next = clean([id, ...readRecent(scope, storage)]);
  try {
    storage?.setItem(recentKey(scope), JSON.stringify(next));
  } catch {
    // Full or blocked storage: the search works without recent results.
  }
  return next;
}
