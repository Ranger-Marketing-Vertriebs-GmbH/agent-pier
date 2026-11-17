// ⌘K entries of the runtimes' surfaces (docs/adr/0007-runtime-descriptor.md): what a
// runtime registers at a slot is found in the search while it shows.
import { agentsHubCopy } from "../../lib/i18n/messages/agents-hub.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { assistantSettingsCopy } from "../../lib/i18n/messages/assistant-settings.js";
import { agentsHubRoute } from "./hub-routes.js";
import { shownSurfaces, slotSurfaces } from "./runtime-surfaces.js";
import { runtimeSearch } from "./runtimes/search.js";
import { agentRoute, visibleAgentTabs } from "./settings/agent-settings-fields.js";

// Where each slot of Agents › Runtime is: the label path above its surfaces and the
// route that lands on them. The slot of an agent's tab is found per agent
// (agentSurfaceEntries).
const places = {
  "hub.runtime": {
    parent: [() => assistantCopy.title, () => agentsHubCopy.tabs.runtime],
    route: () => agentsHubRoute("runtime", "runtimes"),
  },
  // A runtime's own advanced rows: found under Agents › Runtime › Advanced.
  "hub.runtime.advanced": {
    parent: [
      () => assistantCopy.title,
      () => agentsHubCopy.tabs.runtime,
      () => agentsHubCopy.runtime.advanced,
    ],
    route: () => agentsHubRoute("runtime", "advanced"),
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

/**
 * The entries of the surfaces in an agent's Capabilities tab (slot
 * `agent.capabilities`): for each agent that is not archived and has the tab, one
 * entry per surface its runtime's list entry in `runtimes` shows there, labelled
 * "<agent> · <surface>" and opening the tab; and one per page of its runtime the
 * agent's view names (`runtimePages`, slot `agent.page`), opening that page below the
 * tab. `bilingual` and `join` are search-entries.js' builders. Only the owner's index
 * lists them.
 */
export function agentSurfaceEntries(
  agents,
  runtimes,
  { bilingual, join },
  searchOf = runtimeSearch,
) {
  const root = bilingual(() => assistantCopy.title);
  const tab = bilingual(() => assistantSettingsCopy.tabs.capabilities);
  return (agents || []).flatMap((agent) => {
    if (
      !agent?.id ||
      agent.archivedAt ||
      !visibleAgentTabs(agent).includes("capabilities")
    )
      return [];
    const runtimeId = agent.runtimeInfo?.id ?? agent.runtime;
    const runtime = (Array.isArray(runtimes) ? runtimes : []).find(
      (entry) => entry?.id === runtimeId,
    );
    if (!runtime) return [];
    const name = { de: agent.name || agent.id, en: agent.name || agent.id };
    const named = (part) => ({
      de: `${name.de} · ${part.de}`,
      en: `${name.en} · ${part.en}`,
    });
    const pages = Array.isArray(agent.runtimePages) ? agent.runtimePages : [];
    const shown = [
      ...slotSurfaces([runtime], "agent.capabilities"),
      ...slotSurfaces([runtime], "agent.page").filter(({ surface }) =>
        pages.includes(surface.id),
      ),
    ];
    return shown.flatMap(({ surface }) =>
      searchOf(runtime.id)
        .filter((entry) => entry.surface === surface.id)
        .map((entry) => {
          const label = bilingual(entry.label);
          const page = surface.slot === "agent.page" ? surface.id : "";
          return {
            id: `agent:${agent.id}:${runtime.id}-${surface.id}`,
            group: "agents",
            label: named(label),
            path: join(root, name, tab, label),
            target: { route: agentRoute(agent.id, "capabilities", page) },
            agentsOnly: true,
            aliases: (entry.aliases || []).map((alias) => named(bilingual(alias))),
          };
        }),
    );
  });
}
