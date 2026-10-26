// The ⌘K search index (handoff §5.9): every area, tab, settings group and subpage,
// the agents with their tabs, connection names and common actions. Labels are read in
// German and English (`withLanguage`), so both languages match in either UI language;
// old names stay searchable as aliases.
import { withLanguage } from "../lib/i18n/index.js";
import { sidebarCopy } from "../lib/i18n/messages/app.js";
import { artifactCopy } from "../lib/i18n/messages/artifacts.js";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { agentsHubCopy } from "../lib/i18n/messages/agents-hub.js";
import { assistantDreamingCopy } from "../lib/i18n/messages/assistant-dreaming.js";
import { assistantSettingsCopy } from "../lib/i18n/messages/assistant-settings.js";
import { assistantTeamCopy } from "../lib/i18n/messages/assistant-team.js";
import { codingPageCopy } from "../lib/i18n/messages/coding.js";
import { commonCopy } from "../lib/i18n/messages/common.js";
import { connectionsAreaCopy } from "../lib/i18n/messages/connections-area.js";
import { extensionsHubCopy } from "../lib/i18n/messages/extensions.js";
import { filesCopy } from "../lib/i18n/messages/files.js";
import { galleryCopy } from "../lib/i18n/messages/gallery.js";
import { inboxCopy } from "../lib/i18n/messages/inbox.js";
import { mcpDirectoryCopy } from "../lib/i18n/messages/mcp-directory.js";
import { operationsCopy } from "../lib/i18n/messages/operations.js";
import { pipelineCopy } from "../lib/i18n/messages/pipelines.js";
import { pipelineQueueCopy } from "../lib/i18n/messages/pipeline-queue.js";
import { searchCopy } from "../lib/i18n/messages/search.js";
import { settingsHubCopy, settingsPageCopy } from "../lib/i18n/messages/settings.js";
import { systemStatusCopy } from "../lib/i18n/messages/system-status.js";
import { agentsHubRoute } from "../features/assistants/hub-routes.js";
import {
  agentPageAllowed,
  agentRoute,
  visibleAgentTabs,
} from "../features/assistants/settings/agent-settings-fields.js";
import { codingRoute } from "../features/coding/routes.js";
import { connectionsRoute } from "../features/connections/routes.js";
import { projectsRoute } from "../features/projects/routes.js";
import { settingsTabOf } from "../features/operations/routes.js";
import { termsOf } from "./search-index.js";

/** `{ de, en }` of a label read from the reactive catalogs. */
export const bilingual = (read) => ({
  de: withLanguage("de", read),
  en: withLanguage("en", read),
});
const join = (...parts) => ({
  de: parts.map((part) => part.de).join(" › "),
  en: parts.map((part) => part.en).join(" › "),
});

const text = {
  menu: () => sidebarCopy.menu,
  work: () => sidebarCopy.workGroup,
  setup: () => sidebarCopy.setupGroup,
  overview: () => commonCopy.overview,
  inbox: () => inboxCopy.title,
  projects: () => sidebarCopy.projectsNavigation,
  pipelines: () => pipelineCopy.title,
  files: () => filesCopy.tab,
  artifacts: () => artifactCopy.title,
  agents: () => assistantCopy.title,
  clis: () => codingPageCopy.title,
  connections: () => connectionsAreaCopy.title,
  settings: () => commonCopy.settings,
};
const alias = (key) => () => searchCopy.aliases[key];

// A page: `parent` is the label path above it, `aliases` its old names.
function pageEntry(id, label, parent, target, options = {}) {
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

const settingsRoute = (section) => ({
  view: "settings",
  settingsSection: section,
  settingsTab: settingsTabOf(section),
});
const pipelinesRoute = (pipelineTab) => ({
  view: "pipelines",
  pipelineTab,
  pipelineItem: "",
  pipelinePage: 1,
  projectId: "",
  pipelineStatus: "",
});
// Laufzeit's groups under the names the tab shows; `section` scrolls to a group.
const runtimeGroups = [
  ["feature", () => assistantCopy.feature.title, ["agentsFeature"]],
  ["service", () => agentsHubCopy.runtime.service, ["agentService"]],
  ["updates", () => assistantCopy.updates.title],
  ["members", () => assistantTeamCopy.capacity],
  ["dreaming", () => assistantDreamingCopy.title],
  [
    "advanced",
    () => agentsHubCopy.runtime.advanced,
    ["agentServiceAdvanced"],
    "advanced",
  ],
  [
    "storage",
    () => agentsHubCopy.runtime.storage,
    [() => systemStatusCopy.cleanup.dependencies.title],
    "storage",
  ],
];
const extensionTabLabels = {
  skills: () => extensionsHubCopy.tabSkills,
  plugins: () => extensionsHubCopy.tabPlugins,
  marketplaces: () => extensionsHubCopy.tabMarketplaces,
  subagents: () => extensionsHubCopy.tabAgents,
};
const extensionAliases = {
  skills: ["extensionsSkills"],
  plugins: ["extensionsPlugins"],
  marketplaces: ["extensionsMarketplaces"],
  subagents: ["extensionsAgents"],
};

/** The fixed pages: areas, their tabs, settings groups and subpages. */
export function pageEntries() {
  const menuWork = [bilingual(text.menu), bilingual(text.work)];
  const menuSetup = [bilingual(text.menu), bilingual(text.setup)];
  const area = (id, parentPath, target, options) =>
    pageEntry(id, text[id], parentPath, target, { suggested: true, ...options });
  const inbox = [bilingual(text.inbox)];
  const pipelines = [bilingual(text.pipelines)];
  const agents = [bilingual(text.agents)];
  const runtime = [...agents, bilingual(() => agentsHubCopy.tabs.runtime)];
  const clis = [bilingual(text.clis)];
  const extensions = [...clis, bilingual(() => codingPageCopy.tabs.extensions)];
  const connections = [bilingual(text.connections)];
  const settings = [bilingual(text.settings)];
  const general = [...settings, bilingual(() => operationsCopy.groups.general)];
  const operations = [...settings, bilingual(() => operationsCopy.groups.operations)];
  return [
    area("overview", null, { route: { view: "workspace", sessionId: "" } }),
    area("inbox", null, { route: { view: "inbox" } }),
    ...["questions", "approvals", "gates", "agents"].map((tab) =>
      pageEntry(`inbox-${tab}`, () => inboxCopy.tabs[tab], inbox, {
        route: { view: "inbox", inboxTab: tab },
      }),
    ),
    area("projects", menuWork, { route: projectsRoute() }),
    area("pipelines", menuWork, { route: pipelinesRoute("runs") }),
    ...["runs", "definitions", "profiles", "verification"].map((tab) =>
      pageEntry(`pipelines-${tab}`, () => pipelineCopy[tab], pipelines, {
        route: pipelinesRoute(tab),
      }),
    ),
    pageEntry("pipelines-queue", () => pipelineQueueCopy.tab, pipelines, {
      route: pipelinesRoute("queue"),
    }),
    area("files", menuWork, { route: { view: "files" } }),
    area("artifacts", menuWork, { route: { view: "artifacts" } }),
    // "Agenten" stays findable with agents off: it leads to "Agenten aktivieren".
    area(
      "agents",
      menuSetup,
      { route: agentsHubRoute() },
      { aliases: [alias("menuAgents")] },
    ),
    ...["all", "teams", "templates", "runtime"].map((tab) =>
      pageEntry(
        `agents-${tab}`,
        () => agentsHubCopy.tabs[tab],
        agents,
        { route: agentsHubRoute(tab) },
        {
          agentsOnly: true,
          aliases: {
            templates: [alias("agencyCatalog"), alias("extensionsAgents")],
            runtime: [alias("agentService")],
          }[tab],
        },
      ),
    ),
    ...runtimeGroups.map(([group, label, aliases = [], section = ""]) =>
      pageEntry(
        `runtime-${group}`,
        label,
        runtime,
        {
          route: agentsHubRoute("runtime", section),
          ...(group === "storage" ? { pending: "agent-dependencies-cleanup" } : {}),
        },
        {
          agentsOnly: true,
          aliases: aliases.map((name) => (typeof name === "string" ? alias(name) : name)),
        },
      ),
    ),
    area("clis", menuSetup, { route: codingRoute() }, { aliases: [alias("extensions")] }),
    ...["install", "accounts", "extensions", "mcp"].map((tab) =>
      pageEntry(
        `coding-${tab}`,
        () => codingPageCopy.tabs[tab],
        clis,
        tab === "extensions" ? { extensions: "skills" } : { route: codingRoute(tab) },
        {
          aliases: {
            accounts: [alias("accountsCli")],
            extensions: [alias("extensions")],
            mcp: [alias("settingsMcp")],
          }[tab],
        },
      ),
    ),
    ...Object.keys(extensionTabLabels).map((tab) =>
      pageEntry(
        `extensions-${tab}`,
        extensionTabLabels[tab],
        extensions,
        { extensions: tab },
        { aliases: extensionAliases[tab].map(alias) },
      ),
    ),
    area(
      "connections",
      menuSetup,
      { route: connectionsRoute() },
      { aliases: [alias("accounts"), alias("settingsAccess")] },
    ),
    ...["models", "services", "mcp-servers", "ssh", "secrets", "github"].map((section) =>
      pageEntry(
        `connections-${section}`,
        () => connectionsAreaCopy.sections[section],
        connections,
        { route: connectionsRoute(section) },
        {
          agentsOnly: section === "services",
          aliases: {
            models: [alias("accountsModels")],
            services: [alias("accountsServices")],
            "mcp-servers": [alias("accountsMcp")],
            ssh: [alias("settingsSsh"), alias("sshAccesses")],
            secrets: [alias("settingsSecrets")],
            github: [alias("settingsGithub")],
          }[section],
        },
      ),
    ),
    pageEntry(
      "connections-ssh-keys",
      () => searchCopy.sshKeys,
      [...connections, bilingual(() => connectionsAreaCopy.sections.ssh)],
      { route: connectionsRoute("ssh"), pending: "ssh-keys" },
    ),
    area(
      "settings",
      menuSetup,
      { route: settingsRoute("general") },
      { aliases: [alias("settingsWorkspace"), alias("workspace")] },
    ),
    ...["general", "app", "users", "remote", "operations"].map((tab) =>
      pageEntry(
        `settings-${tab}`,
        () => operationsCopy.groups[tab],
        settings,
        {
          route:
            tab === "general"
              ? settingsRoute("general")
              : tab === "operations"
                ? { view: "settings", settingsSection: "general", settingsTab: tab }
                : settingsRoute({ app: "notifications" }[tab] || tab),
        },
        tab === "general"
          ? { aliases: [alias("settingsWorkspace"), alias("workspace")] }
          : undefined,
      ),
    ),
    ...[
      ["language", () => commonCopy.language],
      ["directory", () => settingsPageCopy.settingsFormFieldLabel],
      ["resume", () => settingsPageCopy.autoResumeLabel],
      ["mcp-directory", () => mcpDirectoryCopy.settingsTitle],
      ["features", () => settingsHubCopy.featuresGroup],
    ].map(([id, label]) =>
      pageEntry(`settings-general-${id}`, label, general, {
        route: settingsRoute("general"),
      }),
    ),
    ...["diagnostics", "backups", "updates", "audit"].map((section) =>
      pageEntry(
        `settings-${section}`,
        () => operationsCopy.sections[section],
        operations,
        {
          route: settingsRoute(section),
        },
      ),
    ),
    pageEntry("settings-storage", () => operationsCopy.sections.storage, operations, {
      route: { view: "settings", settingsSection: "general", settingsTab: "operations" },
      pending: "storage-cleanup",
    }),
    pageEntry("settings-components", () => galleryCopy.title, operations, {
      route: settingsRoute("components"),
    }),
  ];
}

// An agent's tabs and the old tab names that lead to them.
const tabAliases = {
  identity: ["profileTab"],
  access: ["workTab"],
  automation: ["routinesTab"],
  channels: ["telegramTab"],
};
const pageKeys = {
  memory: "memory",
  allowlist: "allowlist",
  skills: "skills",
  actions: "actions",
  projects: "projects",
  pipelines: "pipelines",
  ssh: "ssh",
  github: "github",
  secrets: "secrets",
  "telegram-activity": "telegramActivity",
  "telegram-connection": "telegramConnection",
};
const pageTabs = {
  memory: "capabilities",
  allowlist: "capabilities",
  skills: "capabilities",
  actions: "overview",
  projects: "access",
  pipelines: "access",
  ssh: "access",
  github: "access",
  secrets: "access",
  "telegram-activity": "channels",
  "telegram-connection": "channels",
};

/** "Ops-Wache · Zugriffe" and its subpages, for every agent that is not archived. */
export function agentEntries(agents) {
  const root = bilingual(text.agents);
  const tabLabels = Object.fromEntries(
    [
      "overview",
      "identity",
      "capabilities",
      "access",
      "team",
      "automation",
      "channels",
    ].map((tab) => [tab, bilingual(() => assistantSettingsCopy.tabs[tab])]),
  );
  const pageLabels = Object.fromEntries(
    Object.entries(pageKeys).map(([page, key]) => [
      page,
      bilingual(() => searchCopy.agentPages[key]),
    ]),
  );
  const oldTabs = Object.fromEntries(
    Object.values(tabAliases)
      .flat()
      .map((key) => [key, bilingual(alias(key))]),
  );
  const entries = [];
  for (const agent of agents || []) {
    if (!agent?.id || agent.archivedAt) continue;
    const name = { de: agent.name || agent.id, en: agent.name || agent.id };
    const named = (part) => ({
      de: `${name.de} · ${part.de}`,
      en: `${name.en} · ${part.en}`,
    });
    const tabs = visibleAgentTabs(agent);
    for (const tab of tabs)
      entries.push({
        id: `agent:${agent.id}:${tab}`,
        group: "agents",
        label: named(tabLabels[tab]),
        path: join(root, name, tabLabels[tab]),
        target: { route: agentRoute(agent.id, tab) },
        agentsOnly: true,
        aliases: (tabAliases[tab] || []).map((key) => named(oldTabs[key])),
      });
    for (const page of Object.keys(pageKeys)) {
      if (!tabs.includes(pageTabs[page]) || !agentPageAllowed(agent, page)) continue;
      entries.push({
        id: `agent:${agent.id}:${page}`,
        group: "agents",
        label: named(pageLabels[page]),
        path: join(root, name, tabLabels[pageTabs[page]], pageLabels[page]),
        target: { route: agentRoute(agent.id, pageTabs[page], page) },
        agentsOnly: true,
        aliases: [],
      });
    }
  }
  return entries;
}

// Connection names (loaded on the search's first open), each in its Zugänge category.
const connectionKinds = [
  ["models", "models", true],
  ["mcp", "mcp-servers", true],
  ["ssh", "ssh", true],
  ["secrets", "secrets", true],
  ["github", "github", true],
];

/** `connections`: `{ models, mcp, ssh, secrets, github }` lists of `{ id, name, words }`. */
export function connectionEntries(connections) {
  const root = bilingual(text.connections);
  const entries = [];
  for (const [key, section, item] of connectionKinds) {
    const category = bilingual(() => connectionsAreaCopy.sections[section]);
    for (const entry of connections?.[key] || []) {
      if (!entry?.id || !entry.name) continue;
      const name = { de: entry.name, en: entry.name };
      entries.push({
        id: `connection:${key}:${entry.id}`,
        group: "pages",
        label: name,
        path: join(root, category),
        target: { route: connectionsRoute(section, item ? entry.id : undefined) },
        aliases: [],
        extra: (entry.words || []).filter(Boolean),
      });
    }
  }
  return entries;
}

/** The actions: new session, new agent and adding connections. */
export function actionEntries() {
  const connections = bilingual(text.connections);
  const action = (id, label, path, target, options = {}) => ({
    id: `action:${id}`,
    group: "actions",
    label: bilingual(label),
    path,
    target,
    suggested: true,
    aliases: [],
    ...options,
  });
  const inSection = (section) =>
    join(
      connections,
      bilingual(() => connectionsAreaCopy.sections[section]),
    );
  return [
    action("new-session", () => commonCopy.newSession, bilingual(text.overview), {
      action: "launch",
    }),
    action(
      "new-agent",
      () => assistantCopy.create,
      bilingual(text.agents),
      { route: { view: "agents", creating: true } },
      { agentsOnly: true },
    ),
    action("add-ssh", () => searchCopy.actions.addSsh, inSection("ssh"), {
      route: connectionsRoute("ssh"),
      pending: "ssh-add",
    }),
    action("add-ssh-key", () => searchCopy.actions.addSshKey, inSection("ssh"), {
      route: connectionsRoute("ssh"),
      pending: "ssh-key-add",
    }),
    action("add-mcp", () => searchCopy.actions.addMcp, inSection("mcp-servers"), {
      route: connectionsRoute("mcp-servers", "new"),
    }),
    action("add-model", () => searchCopy.actions.addModel, inSection("models"), {
      route: connectionsRoute("models", "new"),
    }),
    action("add-secret", () => searchCopy.actions.addSecret, inSection("secrets"), {
      route: connectionsRoute("secrets"),
      pending: "secret-add",
    }),
    action("add-github", () => searchCopy.actions.addGithub, inSection("github"), {
      route: connectionsRoute("github"),
      pending: "github-add",
    }),
  ];
}

// Terms of an entry: its labels (weight 0), path and old names (1), extra words (2).
function withTerms(entry) {
  const terms = [
    ...termsOf(entry.label.de, 0),
    ...termsOf(entry.label.en, 0),
    ...termsOf(entry.path.de, 1),
    ...termsOf(entry.path.en, 1),
    ...entry.aliases.flatMap((old) => [
      ...termsOf(old.de, 1).map((term) => ({ ...term, alias: old })),
      ...termsOf(old.en, 1).map((term) => ({ ...term, alias: old })),
    ]),
    ...(entry.extra || []).flatMap((word) => termsOf(word, 2)),
  ];
  return { ...entry, terms };
}

/**
 * The whole index. `agents` is the loaded agent list, `connections` the lazily loaded
 * names (or null); with agents off only the "Agenten" area of the agent entries stays.
 */
export function buildSearchIndex({ agents = [], connections = null, agentsEnabled }) {
  return [
    ...pageEntries(),
    ...agentEntries(agents),
    ...connectionEntries(connections),
    ...actionEntries(),
  ]
    .filter((entry) => agentsEnabled || !entry.agentsOnly)
    .map(withTerms);
}
