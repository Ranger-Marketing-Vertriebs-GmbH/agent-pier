import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
const resources = new Set([
  "assistant",
  "artifact",
  "ssh",
  "mcp",
  "account",
  "provider",
  "repository",
  "project",
  "session",
  "request",
  "pipeline",
  "profile",
  "memory",
  "extension",
  "plugin",
  "setting",
  "backup",
  "restore",
  "release",
  "notification",
  "diagnostic",
  "tool",
]);
const verbs = new Set([
  "revoked",
  "denied",
  "created",
  "updated",
  "deleted",
  "started",
  "ended",
  "stopped",
  "failed",
  "completed",
  "answered",
  "expired",
  "handed-off",
  "staged",
  "activated",
  "rolled-back",
  "subscribed",
  "unsubscribed",
  "tested",
  "installed",
  "cancelled",
  "accepted",
  "overridden",
  "retried",
  "reconciled",
  "archived",
  "restored",
  "sent",
  "refreshed",
  "inspected",
]);
// Names of the fields an MCP server or agent binding change can send.
const changeFields = new Set([
  "name",
  "url",
  "auth",
  "oauthScope",
  "command",
  "args",
  "cwd",
  "env",
  "headers",
  "mcpServers",
  "clis",
  "heartbeat",
]);
export function auditId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value))
    throw problem(serverMessages.audit.invalidIdentifier);
  return value;
}
export function auditAction(value) {
  if (value === "ssh.key.exported") return value;
  if (typeof value !== "string") throw problem(serverMessages.audit.invalidAction);
  const [resource, verb, ...rest] = value.split(".");
  if (!resources.has(resource) || !verbs.has(verb) || rest.length)
    throw problem(serverMessages.audit.invalidAction);
  return value;
}
export function auditEvent(input) {
  if (!input || typeof input !== "object")
    throw problem(serverMessages.audit.invalidEvent);
  const action = auditAction(input.action);
  if (
    !resources.has(input.resourceType) ||
    !["user", "system", "mcp"].includes(input.source) ||
    !["success", "failure"].includes(input.outcome)
  )
    throw problem(serverMessages.audit.invalidEventMetadata);
  const event = {
    action,
    resourceType: input.resourceType,
    source: input.source,
    outcome: input.outcome,
    details: {},
  };
  for (const key of ["resourceId", "sessionId", "projectId"])
    if (input[key] !== undefined) event[key] = auditId(input[key]);
  const details = input.details || {};
  if (input.source === "mcp" || input.resourceType === "mcp")
    for (const key of ["grantId", "clientId"])
      if (details[key] !== undefined) event.details[key] = auditId(details[key]);
  // A project merge names the older project it moved into the audited one.
  if (input.resourceType === "project" && details.fromProjectId !== undefined)
    event.details.fromProjectId = auditId(details.fromProjectId);
  if (["codex", "claude", "opencode", "shell", "gh"].includes(details.tool))
    event.details.tool = details.tool;
  if (
    [
      "permission",
      "question",
      "gate",
      "completion",
      "team",
      "action",
      "shell",
      "allowlist",
      "exec",
      "proactivity",
    ].includes(details.kind)
  )
    event.details.kind = details.kind;
  if (
    [
      "allow",
      "deny",
      "answer",
      "handoff",
      "approve",
      "decline",
      "review",
      "allow-once",
      "allow-always",
    ].includes(details.decision)
  )
    event.details.decision = details.decision;
  // Assistant approval decisions name the deciding actor and surface.
  if (["owner", "assistant"].includes(details.actor)) event.details.actor = details.actor;
  if (["ui", "telegram", "mcp", "tool"].includes(details.channel))
    event.details.channel = details.channel;
  if (details.actionId !== undefined) event.details.actionId = auditId(details.actionId);
  // Assistant shell changes name the levels and the allowlist entry removed.
  for (const key of ["shellFrom", "shellTo"])
    if (["off", "approval", "full"].includes(details[key]))
      event.details[key] = details[key];
  if (details.entryId !== undefined) event.details.entryId = auditId(details.entryId);
  // An exec allow-always AgentPier answered: what it sent and what it wrote, never
  // the command (exec-decisions.js).
  if (details.resolvedAs === "allow-once") event.details.resolvedAs = details.resolvedAs;
  if (["written", "skipped", "failed"].includes(details.allowlist))
    event.details.allowlist = details.allowlist;
  if (
    ["interpreter", "inline", "unresolved", "complex"].includes(details.allowlistReason)
  )
    event.details.allowlistReason = details.allowlistReason;
  if (
    typeof details.allowlistError === "string" &&
    /^[A-Za-z0-9_]{1,60}$/.test(details.allowlistError)
  )
    event.details.allowlistError = details.allowlistError;
  if (Array.isArray(details.allowlistEntryIds) && details.allowlistEntryIds.length <= 50)
    event.details.allowlistEntryIds = details.allowlistEntryIds.filter(
      (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id),
    );
  // Pipeline overrides name the stage, the result they overrode and what followed.
  if (input.resourceType === "pipeline") {
    if (details.stageId !== undefined) event.details.stageId = auditId(details.stageId);
    if (
      typeof details.failReason === "string" &&
      /^[a-z]+(?:-[a-z]+){0,4}$/.test(details.failReason)
    )
      event.details.failReason = details.failReason;
    if (["checks-follow", "skips-checks", "gate-decision"].includes(details.path))
      event.details.path = details.path;
  }
  // MCP OAuth logins name why one failed, as a stable code (never state or code).
  if (
    input.resourceType === "mcp" &&
    typeof details.failReason === "string" &&
    /^[a-z]+(?:-[a-z]+){0,4}$/.test(details.failReason)
  )
    event.details.failReason = details.failReason;
  for (const key of ["requestedBy", "teamId"])
    if (details[key] !== undefined) event.details[key] = auditId(details[key]);
  // MCP server changes name the transport, the fields a change sent and whether the
  // owner confirmed a stdio command; never a value.
  if (
    input.resourceType === "mcp" &&
    ["http", "sse", "stdio"].includes(details.transport)
  )
    event.details.transport = details.transport;
  if (["mcp", "assistant"].includes(input.resourceType)) {
    if (Array.isArray(details.fields))
      event.details.fields = details.fields.filter((field) => changeFields.has(field));
    if (typeof details.stdioConfirmed === "boolean")
      event.details.stdioConfirmed = details.stdioConfirmed;
  }
  // CLI bindings name the CLIs, how the owner resolved a conflict and whether a server
  // was adopted from the CLIs; never an entry or a value.
  if (input.resourceType === "mcp") {
    if (Array.isArray(details.clis))
      event.details.clis = details.clis.filter((cli) =>
        ["claude", "codex", "opencode"].includes(cli),
      );
    if (["overwrite", "adopt"].includes(details.resolution))
      event.details.resolution = details.resolution;
    if (typeof details.adopted === "boolean") event.details.adopted = details.adopted;
  }
  // Agent proactivity changes name the switched opt-in as a flag (proactivity-changes.js).
  if (input.resourceType === "assistant" && typeof details.heartbeat === "boolean")
    event.details.heartbeat = details.heartbeat;
  for (const key of ["enabled", "pending"])
    if (typeof details[key] === "boolean") event.details[key] = details[key];
  if (["0.0.0.0", "::"].includes(details.bind)) event.details.bind = details.bind;
  for (const key of ["statusCode", "count", "revision", "skipped"])
    if (Number.isSafeInteger(details[key]) && details[key] >= 0 && details[key] <= 1e9)
      event.details[key] = details[key];
  if (
    typeof details.version === "string" &&
    /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.-]{1,40})?$/.test(details.version)
  )
    event.details.version = details.version;
  return event;
}
const invalidInteger = {
  identifier: serverMessages.audit.invalidIdentifier,
  page: serverMessages.audit.invalidPage,
  boundary: serverMessages.audit.invalidBoundary,
};
export function auditInteger(
  value,
  name,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (
    !["string", "number"].includes(typeof value) ||
    (typeof value === "string" && !/^\d+$/.test(value))
  )
    throw problem(invalidInteger[name]);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw problem(invalidInteger[name]);
  return number;
}
