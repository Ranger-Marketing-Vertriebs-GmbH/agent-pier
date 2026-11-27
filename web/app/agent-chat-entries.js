// ⌘K entries of the owner's agent chat: the agent's pinboard and browser, and the
// chat's own actions (the Chats sheet's New chat, Summarize now and Archived chats,
// and the header's Usage of this chat).
import { agentChatsCopy } from "../lib/i18n/messages/agent-chats.js";
import { agentPinboardCopy } from "../lib/i18n/messages/agent-pinboard.js";
import { assistantBrowserCopy } from "../lib/i18n/messages/assistant-browser.js";
import { assistantUsageCopy } from "../lib/i18n/messages/assistant-usage.js";
import { searchCopy } from "../lib/i18n/messages/search.js";
import {
  browserOffered,
  browserRoute,
} from "../features/assistants/browser/browser-entry.js";

/**
 * "<agent> · Pinboard" (alias "Pinned files"); none on a user's own agent, which has no
 * pinboard. `helpers` are search-entries.js' `bilingual`, `join` and `named`.
 */
export function pinboardEntry(agent, name, root, { bilingual, join, named }) {
  if (agent.userAccess?.mode === "own") return null;
  const label = bilingual(() => agentPinboardCopy.search.pinboard);
  return {
    id: `agent:${agent.id}:pinboard`,
    group: "agents",
    label: named(label),
    path: join(root, name, label),
    target: { route: { view: "agents", assistantId: agent.id, pinboard: true } },
    agentsOnly: true,
    aliases: [named(bilingual(() => agentPinboardCopy.search.alias))],
  };
}

/**
 * "<agent>'s browser" ("Browser von <agent>"), while its browser capability is on,
 * running or not (browser-entry.js); the page starts it. Alias: the settings' "Open
 * live view". `helpers` as for pinboardEntry.
 */
export function browserEntry(agent, name, root, { bilingual, join, named }) {
  if (!browserOffered(agent)) return null;
  const label = bilingual(() => assistantBrowserCopy.entrySearch(name.en));
  return {
    id: `agent:${agent.id}:browser`,
    group: "agents",
    label,
    path: join(
      root,
      name,
      bilingual(() => assistantBrowserCopy.entry),
    ),
    target: { route: browserRoute(agent.id) },
    // The agent's initial in both languages, not the label's ("B" and "O").
    mark: name.en,
    agentsOnly: true,
    aliases: [named(bilingual(() => assistantBrowserCopy.liveOpen))],
  };
}

/**
 * New chat, Summarize this chat, Archived chats and Usage of this chat. The chat on
 * screen takes them (usePageAction in AgentChatTop and ChatUsageButton), so the search offers each only while one is mounted that can run it
 * (`offer`). `action` is search-entries.js' action builder.
 */
export function chatActionEntries(action, path, bilingual) {
  return [
    action(
      "chat-new",
      () => agentChatsCopy.newChat,
      path,
      { action: "chat-new", pending: "chat-new" },
      { offer: "chat-new", suggested: false },
    ),
    action(
      "chat-summarise",
      () => searchCopy.actions.summariseChat,
      path,
      { action: "chat-summarise", pending: "chat-summarise" },
      {
        offer: "chat-summarise",
        suggested: false,
        aliases: [
          bilingual(() => agentChatsCopy.summariseNow),
          bilingual(() => agentChatsCopy.summariseThisChat),
        ],
      },
    ),
    action(
      "chat-archived",
      () => agentChatsCopy.showArchived,
      path,
      { action: "chat-archived", pending: "chat-archived" },
      { offer: "chat-archived", suggested: false },
    ),
    // The chat's tokens, cost and context fill (ChatUsageButton).
    action(
      "chat-usage",
      () => assistantUsageCopy.chat.title,
      path,
      { action: "chat-usage", pending: "chat-usage" },
      {
        offer: "chat-usage",
        suggested: false,
        aliases: [bilingual(() => assistantUsageCopy.search.chatTokens)],
      },
    ),
  ];
}
