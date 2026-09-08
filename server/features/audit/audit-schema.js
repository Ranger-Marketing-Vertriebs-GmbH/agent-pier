import { problem } from "../../lib/storage.js";
const resources = new Set([
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
export function auditId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(value))
    throw problem("Invalid audit identifier.");
  return value;
}
export function auditAction(value) {
  if (typeof value !== "string") throw problem("Invalid audit action.");
  const [resource, verb, ...rest] = value.split(".");
  if (!resources.has(resource) || !verbs.has(verb) || rest.length)
    throw problem("Invalid audit action.");
  return value;
}
export function auditEvent(input) {
  if (!input || typeof input !== "object") throw problem("Invalid audit event.");
  const action = auditAction(input.action);
  if (
    !resources.has(input.resourceType) ||
    !["user", "system", "mcp"].includes(input.source) ||
    !["success", "failure"].includes(input.outcome)
  )
    throw problem("Invalid audit event metadata.");
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
  if (["codex", "claude", "opencode", "shell", "gh"].includes(details.tool))
    event.details.tool = details.tool;
  if (["permission", "question", "gate", "completion"].includes(details.kind))
    event.details.kind = details.kind;
  if (["allow", "deny", "answer", "handoff"].includes(details.decision))
    event.details.decision = details.decision;
  for (const key of ["statusCode", "count", "revision"])
    if (Number.isSafeInteger(details[key]) && details[key] >= 0 && details[key] <= 1e9)
      event.details[key] = details[key];
  if (
    typeof details.version === "string" &&
    /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.-]{1,40})?$/.test(details.version)
  )
    event.details.version = details.version;
  return event;
}
export function auditInteger(
  value,
  name,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  if (
    !["string", "number"].includes(typeof value) ||
    (typeof value === "string" && !/^\d+$/.test(value))
  )
    throw problem(`Invalid audit ${name}.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw problem(`Invalid audit ${name}.`);
  return number;
}
