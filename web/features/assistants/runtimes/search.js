import { hermesSearch } from "./hermes/search.js";
import { openClawSearch } from "./openclaw/search.js";

/**
 * The ids of every runtime's own agent pages (its surfaces at the slot agent.page),
 * which the agent settings route below the Capabilities tab (settings-routes.js).
 */
export const runtimePageIds = Object.freeze([
  ...new Set([hermesSearch, openClawSearch].flatMap((runtime) => runtime.pages || [])),
]);

// The ⌘K search entries of the runtimes' web descriptors (index.js), by runtime id,
// without their components: the search index loads before any runtime UI does.
const registered = Object.freeze({
  [hermesSearch.id]: hermesSearch.entries,
  [openClawSearch.id]: openClawSearch.entries,
});

/**
 * The search entries runtime `id` registers: `[{ surface, label, aliases }]`, one per
 * surface, `label` and each alias a reader of the reactive catalogs. [] for a runtime
 * without any.
 */
export const runtimeSearch = (id) =>
  typeof id === "string" && Object.hasOwn(registered, id) ? registered[id] : [];
