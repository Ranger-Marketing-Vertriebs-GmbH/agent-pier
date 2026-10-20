import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { memberLevel } from "./user-access.js";

// The body of an unknown /api route: a refusal never confirms that something exists.
const refused = () => problem(serverMessages.http.notFound, 404);

/**
 * What a restricted user may reach of the agents: her own and shared agents, her level
 * on each, her conversations and the browser views she may watch. Every /api/me
 * handler asks it before it touches agent data; a refusal is the unknown-route 404.
 */
export class UserScope {
  constructor(services) {
    this.services = services;
  }
  /** The unknown-route 404 every refusal answers with. */
  refusal() {
    return refused();
  }
  get store() {
    return this.services.assistants?.store || null;
  }
  // The agents that serve the user, archived ones excluded; none while agents are off.
  agentsFor(userId) {
    const store = this.store;
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
  /** One of the user's agents, or the unknown-route 404. */
  agentOf(principal, agentId) {
    const agent = this.agentsFor(principal?.userId).find((a) => a.id === agentId);
    if (!agent) throw refused();
    return agent;
  }
  /**
   * The user's own conversation: hers (`userId`), not archived, on an agent she still
   * belongs to. Anything else, also another user's or the owner's chat, is a 404.
   */
  conversationOf(principal, conversationId) {
    const store = this.store;
    if (!store || principal?.role !== "user" || typeof conversationId !== "string")
      throw refused();
    let conversation;
    try {
      conversation = store.getConversation(conversationId);
    } catch {
      throw refused();
    }
    if (conversation.userId !== principal.userId || conversation.archivedAt)
      throw refused();
    this.agentOf(principal, conversation.assistantId);
    return conversation;
  }
  /** The conversation of a turn (attempt id) the user may cancel. */
  attemptOf(principal, attemptId) {
    const ledger = this.services.assistants?.ledger;
    let conversationId;
    try {
      const attempt = ledger.getAttempt(attemptId);
      conversationId = ledger.getRequest(attempt.requestId).conversationId;
    } catch {
      throw refused();
    }
    return this.conversationOf(principal, conversationId);
  }
  /** The conversation of a chat file (an attachment or a shared file). */
  attachmentOf(principal, fileId) {
    const conversationId = this.services.assistants?.attachments?.conversationOf(fileId);
    if (!conversationId) throw refused();
    return this.conversationOf(principal, conversationId);
  }
  mayWatchBrowser(_principal, _agentId) {
    return false;
  }
}
