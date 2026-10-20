import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { memberLevel } from "./user-access.js";

/**
 * What a restricted user may reach of the agents: her own and shared agents, her level
 * on each, her conversations and the browser views she may watch. Conversations and
 * browser views follow with per-user chats (Slice 4); until then they are refused.
 */
export class UserScope {
  constructor(services) {
    this.services = services;
  }
  // The agents that serve the user, archived ones excluded; none while agents are off.
  agentsFor(userId) {
    const store = this.services.assistants?.store;
    if (!store || typeof userId !== "string") return [];
    return store
      .listAssistants()
      .filter((agent) => !agent.archivedAt && memberLevel(agent, userId));
  }
  level(agentId, userId) {
    return memberLevel(
      this.agentsFor(userId).find((agent) => agent.id === agentId),
      userId,
    );
  }
  // Throws the unknown-route 404 unless the conversation is the user's own.
  conversationOf(_principal, _conversationId) {
    throw problem(serverMessages.http.notFound, 404);
  }
  mayWatchBrowser(_principal, _agentId) {
    return false;
  }
}
