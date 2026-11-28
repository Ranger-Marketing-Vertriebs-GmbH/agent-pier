// ⌘K entries of each agent: its settings tabs and subpages ("Ops-Wache · Zugriffe"),
// its pinboard and browser, and its own actions (Duplicate, Archive, Restart main chat, Clear
// attachments), which open the agent's settings and the dialog behind the action.
import { agentLifecycleCopy } from "../lib/i18n/messages/agent-lifecycle.js";
import { assistantAttachmentsCopy } from "../lib/i18n/messages/assistant-attachments.js";
import { assistantSettingsCopy } from "../lib/i18n/messages/assistant-settings.js";
import { assistantCopy } from "../lib/i18n/messages/assistants.js";
import { assistantProactivityCopy } from "../lib/i18n/messages/assistant-proactivity.js";
import { assistantShellCopy } from "../lib/i18n/messages/assistant-shell.js";
import { assistantUsageCopy } from "../lib/i18n/messages/assistant-usage.js";
import { devicesCopy } from "../lib/i18n/messages/devices.js";
import { hookCopy } from "../lib/i18n/messages/assistant-hooks.js";
import { leadRequestCopy } from "../lib/i18n/messages/lead-requests.js";
import { routineCopy } from "../lib/i18n/messages/assistant-routines.js";
import { searchCopy } from "../lib/i18n/messages/search.js";
import {
  agentPageAllowed,
  agentRoute,
  isPersonal,
  visibleAgentTabs,
} from "../features/assistants/settings/agent-settings-fields.js";
import { browserEntry, pinboardEntry } from "./agent-chat-entries.js";
import { alias, bilingual, join, text } from "./search-labels.js";

// An agent's tabs and the old tab names that lead to them.
const tabAliases = {
  identity: ["profileTab"],
  // What the tab holds: "Learns its own skills" and the names people search it by.
  capabilities: ["skillLearning", "selfLearning", "learnSkills", "skillWorkshop"],
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
// Names of what an agent's subpage holds, so searching for them finds the page.
const pageAliases = { memory: ["memoryPins"], projects: ["sessionTalk"] };
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

// The groups inside an agent's tabs that people search by their own names
// (AGENTPIER-445): [id, tab, label, applies(agent, host), old names, words]. Each
// opens its tab, where the group shows under that name. `host` says what this host
// offers (`devicesAvailable`); `words` are further words people type for the group.
// The owner's own agents and permanent members: a temporary member's groups are its
// lead's to set.
const ownAgent = (agent) => !agent.userAccess && isPersonal(agent);
const agentGroups = [
  ["routines", "automation", () => routineCopy.title, ownAgent],
  ["reminders", "automation", () => assistantCopy.personal.reminders, ownAgent],
  ["hooks", "automation", () => hookCopy.title, ownAgent],
  ["check-ins", "automation", () => assistantProactivityCopy.heartbeat, () => true],
  // Also found by the name of its model-reviewed level.
  [
    "shell",
    "capabilities",
    () => assistantShellCopy.title,
    ownAgent,
    [() => assistantShellCopy.levels.review],
  ],
  // What the agent's sessions used, on its Overview (UsageGroup.jsx).
  [
    "usage",
    "overview",
    () => assistantUsageCopy.title,
    // A user's own agent shows no usage group.
    (agent) => agent.userAccess?.mode !== "own",
    [() => assistantUsageCopy.search.tokens, () => assistantUsageCopy.search.cost],
  ],
  [
    "member-groups",
    "team",
    () => searchCopy.agentGroups.memberGroups,
    () => true,
    [() => leadRequestCopy.groups.title],
  ],
  // The agent's Android devices on its Access tab (DevicesAccess.jsx): every agent
  // of the owner's, also a member, while the host offers devices.
  [
    "devices",
    "access",
    () => devicesCopy.title,
    (agent, host) => host.devicesAvailable === true && !agent.userAccess,
    [],
    [
      "Android Emulator",
      "Android phone",
      "Android Handy",
      "Android Telefon",
      "assign device",
      "Gerät zuweisen",
    ],
  ],
];

/**
 * "Ops-Wache · Zugriffe" and its subpages, for every agent that is not archived.
 * `host.devicesAvailable` adds each agent's Android devices.
 */
export function agentEntries(agents, host = {}) {
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
    for (const [group, tab, label, applies, old = [], words = []] of agentGroups) {
      if (!tabs.includes(tab) || !applies(agent, host)) continue;
      const own = bilingual(label);
      entries.push({
        id: `agent:${agent.id}:group:${group}`,
        group: "agents",
        label: named(own),
        path: join(root, name, tabLabels[tab], own),
        target: { route: agentRoute(agent.id, tab) },
        agentsOnly: true,
        aliases: old.map((key) => named(bilingual(key))),
        // Every word of a query must be in one term, so each word carries the name.
        ...(words.length ? { extra: words.map((word) => `${name.en} ${word}`) } : {}),
      });
    }
    const pinboard = pinboardEntry(agent, name, root, { bilingual, join, named });
    if (pinboard) entries.push(pinboard);
    const browser = browserEntry(agent, name, root, { bilingual, join, named });
    if (browser) entries.push(browser);
    for (const page of Object.keys(pageKeys)) {
      if (!tabs.includes(pageTabs[page]) || !agentPageAllowed(agent, page)) continue;
      entries.push({
        id: `agent:${agent.id}:${page}`,
        group: "agents",
        label: named(pageLabels[page]),
        path: join(root, name, tabLabels[pageTabs[page]], pageLabels[page]),
        target: { route: agentRoute(agent.id, pageTabs[page], page) },
        agentsOnly: true,
        aliases: (pageAliases[page] || []).map((key) => named(bilingual(alias(key)))),
      });
    }
  }
  return entries;
}

// An agent's own actions: [id, label, applies(agent), target(agent), old names]. A `pending` page
// action opens the action's dialog once the agent's settings show it; Archive and
// Duplicate open the place where they are done (the settings' Manage group and the
// new agent wizard prefilled from this agent), so nothing changes without a click.
const agentActions = [
  [
    "duplicate",
    () => assistantSettingsCopy.duplicate,
    (agent) => isPersonal(agent),
    (agent) => ({ route: { view: "agents", creating: true, duplicate: agent.id } }),
  ],
  [
    "archive",
    () => agentLifecycleCopy.archive,
    () => true,
    (agent) => ({ route: agentRoute(agent.id) }),
  ],
  [
    "main-chat-restart",
    () => assistantSettingsCopy.mainChatRestart.row,
    (agent) => !agent.teamMemberId,
    (agent) => ({
      route: agentRoute(agent.id),
      pending: `agent-main-chat-restart:${agent.id}`,
    }),
    ["restartMainChat"],
  ],
  [
    "attachments-clear",
    () => assistantAttachmentsCopy.storageClear,
    // Its users' files are theirs: the owner never clears a user agent.
    (agent) => !agent.userAccess,
    (agent) => ({
      route: agentRoute(agent.id),
      pending: `agent-attachments-clear:${agent.id}`,
    }),
  ],
];

/** "<agent> · Duplicate" and the other actions, for every agent that is not archived. */
export function agentActionEntries(agents) {
  const root = bilingual(text.agents);
  const entries = [];
  for (const agent of agents || []) {
    if (!agent?.id || agent.archivedAt) continue;
    const name = agent.name || agent.id;
    for (const [id, label, applies, target, old = []] of agentActions) {
      if (!applies(agent)) continue;
      const own = bilingual(label);
      entries.push({
        id: `agent:${agent.id}:action:${id}`,
        group: "actions",
        label: { de: `${name} · ${own.de}`, en: `${name} · ${own.en}` },
        path: join(root, { de: name, en: name }),
        target: target(agent),
        agentsOnly: true,
        aliases: old.map((key) => {
          const named = bilingual(alias(key));
          return { de: `${name} · ${named.de}`, en: `${name} · ${named.en}` };
        }),
        extra: [name],
      });
    }
  }
  return entries;
}
