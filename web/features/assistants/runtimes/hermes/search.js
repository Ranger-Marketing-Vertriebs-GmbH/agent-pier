import { agentsHubCopy } from "../../../../lib/i18n/messages/agents-hub.js";

const copy = () => agentsHubCopy.runtime.hermes;

/**
 * Hermes Agent's id and its ⌘K search entries: one per surface, `label` and `aliases`
 * read from the reactive catalogs. No component here, so the search index (and Node)
 * loads it without the runtime's UI; index.js adds the components.
 */
export const hermesSearch = Object.freeze({
  id: "hermes",
  entries: Object.freeze([
    Object.freeze({
      surface: "install",
      label: () => copy().title,
      aliases: Object.freeze([
        () => copy().search.second,
        () => copy().search.install,
        () => copy().search.update,
      ]),
    }),
  ]),
});
