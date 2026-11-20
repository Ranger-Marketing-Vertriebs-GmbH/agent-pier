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

/**
 * What an event did in words, where its generic action ("assistant.updated") says
 * too little (AGENTPIER-445): a browser upload names its step, file and site. ""
 * for any other event.
 */
export function auditSummary(event) {
  const details = event?.details || {};
  if (details.kind !== "browser-upload") return "";
  const step = copy.browserUpload[details.browserUpload] || copy.browserUpload.staged;
  return [
    step,
    typeof details.filePath === "string" ? details.filePath : "",
    typeof details.declaredSite === "string" ? copy.uploadSite(details.declaredSite) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
