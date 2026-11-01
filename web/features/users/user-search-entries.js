// The search in a restricted user's own app (AGENTPIER-224, docs/users.md): only what
// the user's app can open. Its entries come from the user's own agent list (`/api/me`, pushed on
// `me.agents`): each agent's chat, settings and memory, plus My agents and Account.
// Nothing of the owner's (sessions, projects, pipelines, settings) is ever indexed.
import { withLanguage } from "../../lib/i18n/index.js";
import { searchCopy } from "../../lib/i18n/messages/search.js";
import { userAppCopy } from "../../lib/i18n/messages/user-app.js";
import { termsOf } from "../../app/search-index.js";

const bilingual = (read) => ({
  de: withLanguage("de", read),
  en: withLanguage("en", read),
});
const same = (text) => ({ de: text, en: text });

function withTerms(entry) {
  return {
    ...entry,
    aliases: [],
    terms: [
      ...termsOf(entry.label.de, 0),
      ...termsOf(entry.label.en, 0),
      ...termsOf(entry.path.de, 1),
      ...termsOf(entry.path.en, 1),
      // "Lumi memory" finds the page: path and label read as one.
      ...termsOf(`${entry.path.de} ${entry.label.de}`, 2),
      ...termsOf(`${entry.path.en} ${entry.label.en}`, 2),
    ],
  };
}

/** The user's pages and their agents' chats, settings and memory, with terms. */
export function buildUserSearchIndex({ agents = [] } = {}) {
  const root = bilingual(() => userAppCopy.myAgents);
  const entries = [
    {
      id: "user:agents",
      group: "pages",
      label: root,
      path: same(userAppCopy.brand),
      target: { route: { view: "agents" } },
      suggested: true,
    },
    {
      id: "user:account",
      group: "pages",
      label: bilingual(() => userAppCopy.account),
      path: same(userAppCopy.brand),
      target: { route: { view: "account" } },
      suggested: true,
    },
  ];
  for (const agent of agents || []) {
    if (!agent?.id || !agent.name) continue;
    const path = {
      de: `${root.de} › ${agent.name}`,
      en: `${root.en} › ${agent.name}`,
    };
    entries.push(
      {
        id: `user:chat:${agent.id}`,
        group: "chats",
        label: bilingual(() => searchCopy.user.chatWith(agent.name)),
        path,
        mark: agent.avatar || agent.name,
        target: { openAgent: agent.id },
      },
      {
        id: `user:settings:${agent.id}`,
        group: "agents",
        label: bilingual(() => userAppCopy.settingsOf(agent.name)),
        path,
        mark: agent.avatar || agent.name,
        target: { route: { view: "settings", agentId: agent.id } },
      },
      {
        id: `user:memory:${agent.id}`,
        group: "agents",
        label: bilingual(() => userAppCopy.memory),
        path,
        mark: agent.avatar || agent.name,
        target: { route: { view: "settings", agentId: agent.id, page: "memory" } },
      },
    );
  }
  return entries.map(withTerms);
}
