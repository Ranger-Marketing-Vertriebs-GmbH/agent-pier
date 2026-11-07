// ⌘K entries of the owner's agent chat: the agent's pinboard and the chat's own
// actions (the compact header's New chat and Summarize now).
import { agentChatsCopy } from "../lib/i18n/messages/agent-chats.js";
import { agentPinboardCopy } from "../lib/i18n/messages/agent-pinboard.js";
import { searchCopy } from "../lib/i18n/messages/search.js";

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
 * New chat and Summarize this chat. The chat on screen takes them (usePageAction in
 * AgentChatTop), so the search offers each only while one is mounted that can run it
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
        aliases: [bilingual(() => agentChatsCopy.summariseNow)],
      },
    ),
  ];
}
