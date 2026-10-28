import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

/**
 * Who acted: a user by name, an agent by name (server/http/routes/audit.js adds
 * `agentName` while the agent exists), the owner, MCP or the system.
 */
export function auditActor(event) {
  if (event.actorUserId)
    return event.actorName ? copy.byUser(event.actorName) : copy.byDeletedUser;
  if (event.source === "agent")
    return event.agentName ? copy.byAgentName(event.agentName) : copy.byAgent;
  if (event.source === "user") return copy.byOwner;
  return event.source === "mcp" ? copy.sourceMcp : copy.sourceSystem;
}
