// The live Craft Anything rebuild topics, owner only. `craft.rebuilds` is the rebuild
// list with the owner's defaults, the eligible accounts, the stacks and whether Craft
// Anything is installed: the value GET /api/craft/rebuilds answers.
// `craft.rebuild:<id>` is one rebuild, the value GET /api/craft/rebuilds/:id answers;
// one that does not exist (any more) answers `{ rebuild: null }`. CraftRebuilds'
// onChange signals both through craftRebuildsChanged, and the Craft Anything tool's
// onChange signals the list (its `installed`); the topics follow nothing themselves.

import { assistantProblem } from "../assistants/assistant-validation.js";
import { craftStacks } from "./craft-stacks.js";
import { REBUILD_ID } from "./rebuild-questions.js";

export { REBUILD_ID };

const owner = (principal) => principal?.role === "owner";

/** The supervisor, or a 503 without it (no MCP server store, no Craft Anything). */
export function craftRebuildsService(services) {
  if (!services.craftRebuilds)
    throw Object.assign(assistantProblem("unavailable", 503), { expected: true });
  return services.craftRebuilds;
}

/** The value of GET /api/craft/rebuilds and `craft.rebuilds`. */
export function craftRebuildsView(services) {
  const rebuilds = craftRebuildsService(services);
  return {
    rebuilds: rebuilds.list(),
    settings: rebuilds.settings(),
    accounts: rebuilds.eligibleAccounts(),
    stacks: [...craftStacks],
    installed: !!services.craft?.state().installed,
  };
}

/**
 * Signals the topics of a CraftRebuilds change on `hub` (services.live, absent until
 * it exists): `{ id }` one rebuild and the list, `{ list: true }` the list and every
 * rebuild (one may have come or gone), nothing the list alone.
 */
export function craftRebuildsChanged(hub, event = {}) {
  if (!hub) return;
  hub.invalidate("craft.rebuilds");
  if (typeof event.id === "string") hub.invalidate("craft.rebuild", event.id);
  else if (event.list) hub.invalidate("craft.rebuild");
}

/** The `craft.rebuilds` topic definition for LiveHub#define. */
export function craftRebuildsTopic(services) {
  return {
    name: "craft.rebuilds",
    mode: "state",
    authorize: owner,
    scopeKey: () => "owner",
    read: () => craftRebuildsView(services),
  };
}

/** The `craft.rebuild` topic definition for LiveHub#define. */
export function craftRebuildTopic(services) {
  return {
    name: "craft.rebuild",
    mode: "state",
    param: REBUILD_ID,
    authorize: owner,
    scopeKey: () => "owner",
    read: (_principal, id) => ({ rebuild: craftRebuildsService(services).get(id) }),
  };
}
