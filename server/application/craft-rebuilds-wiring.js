import { CraftRebuilds } from "../features/craft/craft-rebuilds.js";
import { craftRebuildsChanged } from "../features/craft/live-topics.js";

/**
 * The Craft Anything rebuild supervisor over the managed tool (`services.craft`), or
 * null without it. Its changes reach the live topics on `services.live`, read late:
 * the hub exists only once the server listens. Restored in app.js after the tool
 * starts, closed in shutdown.js.
 */
export function createCraftRebuilds(services) {
  const { config, craft, accounts, preferences, memory } = services;
  if (!craft) return null;
  const rebuilds = new CraftRebuilds({
    dataDir: config.dataDir,
    craft,
    accounts,
    preferences,
    memory,
  });
  rebuilds.onChange((event) => craftRebuildsChanged(services.live, event));
  return rebuilds;
}
