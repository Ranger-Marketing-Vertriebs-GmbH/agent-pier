import { assistantMemoryWikiCopy as copy } from "../../../../lib/i18n/messages/assistant-memory-wiki.js";

/**
 * OpenClaw's id and its ⌘K search entries: one per surface, `label` and `aliases`
 * read from the reactive catalogs. No component here, so the search index (and Node)
 * loads it without the runtime's UI; index.js adds the components.
 */
export const openClawSearch = Object.freeze({
  id: "openclaw",
  entries: Object.freeze([
    // An agent's Capabilities tab › Memory wiki, for each OpenClaw agent.
    Object.freeze({
      surface: "memoryWiki",
      label: () => copy.title,
      aliases: Object.freeze([() => copy.search.wiki, () => copy.search.knowledge]),
    }),
    // The agent's wiki, read only, for each agent that keeps one.
    Object.freeze({
      surface: "wiki",
      label: () => copy.search.wiki,
      aliases: Object.freeze([() => copy.title, () => copy.search.knowledge]),
    }),
  ]),
});
