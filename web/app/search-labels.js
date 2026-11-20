// The ⌘K index's building blocks, shared by its entry modules (search-entries.js,
// agent-search-entries.js, area-search-entries.js and the quick-open entries): labels in
// both languages, label paths, the area names and page entries.
import { withLanguage } from "../lib/i18n/index.js";
import { sidebarCopy } from "../lib/i18n/messages/app.js";
import { artifactCopy } from "../lib/i18n/messages/artifacts.js";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { codingPageCopy } from "../lib/i18n/messages/coding.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { craftCopy } from "../lib/i18n/messages/craft.js";
import { connectionsAreaCopy } from "../lib/i18n/messages/connections-area.js";
import { filesCopy } from "../lib/i18n/messages/files.js";
import { inboxCopy } from "../lib/i18n/messages/inbox.js";
import { pipelineCopy } from "../lib/i18n/messages/pipelines.js";
import { searchCopy } from "../lib/i18n/messages/search.js";
import { settingsTabOf } from "../features/operations/routes.js";

/** `{ de, en }` of a label read from the reactive catalogs. */
export const bilingual = (read) => ({
  de: withLanguage("de", read),
  en: withLanguage("en", read),
});
export const join = (...parts) => ({
  de: parts.map((part) => part.de).join(" › "),
  en: parts.map((part) => part.en).join(" › "),
});
/** The same text in both languages (a name). */
export const same = (value) => ({ de: String(value ?? ""), en: String(value ?? "") });

export const text = {
  menu: () => sidebarCopy.menu,
  work: () => sidebarCopy.workGroup,
  setup: () => sidebarCopy.setupGroup,
  overview: () => commonCopy.overview,
  inbox: () => inboxCopy.title,
  projects: () => sidebarCopy.projectsNavigation,
  craft: () => craftCopy.title,
  pipelines: () => pipelineCopy.title,
  files: () => filesCopy.tab,
  artifacts: () => artifactCopy.title,
  agents: () => assistantCopy.title,
  clis: () => codingPageCopy.title,
  connections: () => connectionsAreaCopy.title,
  settings: () => commonCopy.settings,
};
/** An old name of the search catalog, as a label reader. */
export const alias = (key) => () => searchCopy.aliases[key];

/** A page: `parent` is the label path above it, `aliases` its old names. */
export function pageEntry(id, label, parent, target, options = {}) {
  const own = bilingual(label);
  const path = parent ? join(...parent, own) : own;
  return {
    id: `page:${id}`,
    group: "pages",
    label: own,
    path,
    target,
    ...options,
    aliases: (options.aliases || []).map(bilingual),
  };
}

export const settingsRoute = (section) => ({
  view: "settings",
  settingsSection: section,
  settingsTab: settingsTabOf(section),
});
export const pipelinesRoute = (pipelineTab) => ({
  view: "pipelines",
  pipelineTab,
  pipelineItem: "",
  pipelinePage: 1,
  projectId: "",
  pipelineStatus: "",
});
