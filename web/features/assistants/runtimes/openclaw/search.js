import { assistantMemoryWikiCopy as copy } from "../../../../lib/i18n/messages/assistant-memory-wiki.js";
import { assistantModelOptionsCopy as modelCopy } from "../../../../lib/i18n/messages/assistant-model-options.js";

/**
 * OpenClaw's id and its ⌘K search entries: one per surface, `label` and `aliases`
 * read from the reactive catalogs. No component here, so the search index (and Node)
 * loads it without the runtime's UI; index.js adds the components.
 */
export const openClawSearch = Object.freeze({
  id: "openclaw",
  // Its surfaces at the slot agent.page: pages below an agent's Capabilities tab.
  pages: Object.freeze(["wiki"]),
  entries: Object.freeze([
    // An agent's Capabilities tab › Memory wiki, for each OpenClaw agent.
    Object.freeze({
      surface: "memoryWiki",
      label: () => copy.title,
      aliases: Object.freeze([() => copy.search.wiki, () => copy.search.knowledge]),
    }),
    // An agent's Identity tab › Model behaviour, for each OpenClaw agent.
    Object.freeze({
      surface: "modelOptions",
      label: () => modelCopy.title,
      aliases: Object.freeze([
        () => modelCopy.search.thinking,
        () => modelCopy.search.fast,
        () => modelCopy.search.effort,
        () => modelCopy.search.loop,
      ]),
    }),
    // The agent's wiki, read only, for each agent that keeps one.
    Object.freeze({
      surface: "wiki",
      label: () => copy.search.wiki,
      aliases: Object.freeze([() => copy.title, () => copy.search.knowledge]),
    }),
  ]),
});
