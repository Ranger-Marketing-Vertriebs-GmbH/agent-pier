import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";

/**
 * What a restricted user may reach of the agents: her own and shared agents, her level
 * on each, her conversations and the browser views she may watch. Until user agents
 * exist (Slices 3 and 4) a user reaches nothing, so every answer is a refusal.
 */
export class UserScope {
  constructor(services) {
    this.services = services;
  }
  agentsFor(_userId) {
    return [];
  }
  level(_agentId, _userId) {
    return null;
  }
  // Throws the unknown-route 404 unless the conversation is the user's own.
  conversationOf(_principal, _conversationId) {
    throw problem(serverMessages.http.notFound, 404);
  }
  mayWatchBrowser(_principal, _agentId) {
    return false;
  }
}
