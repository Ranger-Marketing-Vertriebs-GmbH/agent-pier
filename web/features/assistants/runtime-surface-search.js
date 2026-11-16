// ⌘K entries of the runtimes' surfaces (docs/adr/0007-runtime-descriptor.md): what a
// runtime registers at a slot is found in the search while it shows.
import { agentsHubCopy } from "../../lib/i18n/messages/agents-hub.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { agentsHubRoute } from "./hub-routes.js";
import { shownSurfaces } from "./runtime-surfaces.js";
import { runtimeSearch } from "./runtimes/search.js";

// Where each slot is: the label path above its surfaces and the route that lands on
// them. Every slot of the server's RUNTIME_SLOTS has its place here.
const places = {
  "hub.runtime": {
    parent: [() => assistantCopy.title, () => agentsHubCopy.tabs.runtime],
    route: () => agentsHubRoute("runtime", "runtimes"),
  },
};

/**
 * The page entries of the surfaces that show in the runtime list `runtimes`: for
 * each, what its runtime's web descriptor registers for it (`searchOf(runtimeId)`:
 * `[{ surface, label, aliases }]`). `pageEntry` and `bilingual` are search-entries.js'
 * builders. Agents › Runtime exists only with agents on.
 */
export function surfaceSearchEntries(
  runtimes,
  pageEntry,
  bilingual,
  searchOf = runtimeSearch,
) {
  return shownSurfaces(runtimes).flatMap(({ runtime, surface }) => {
    const place = Object.hasOwn(places, surface.slot) ? places[surface.slot] : null;
    if (!place) return [];
    return searchOf(runtime.id)
      .filter((entry) => entry.surface === surface.id)
      .map((entry) =>
        pageEntry(
          `runtime-${runtime.id}-${surface.id}`,
          entry.label,
          place.parent.map(bilingual),
          { route: place.route() },
          { agentsOnly: true, aliases: entry.aliases || [] },
        ),
      );
  });
}
