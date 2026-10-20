import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import {
  advancedSettingById,
  auditableSettingValue,
} from "../assistants/openclaw-config/advanced-settings.js";
import { MCP_SERVER_ORIGINS } from "../mcp-servers/server-origins.js";
import { sshAuditDetails } from "./audit-ssh-details.js";
import { MAX_TOKEN_BUDGET } from "../pipelines/run-budget.js";
import { MAX_QUEUE_CONCURRENCY } from "../pipelines/queue-policy.js";
import { teamAuditDetails } from "./audit-team-details.js";
import { SCAN_RULES, SCAN_VERDICTS } from "../extensions/skill-scan.js";
const memberGrantKeys = new Set([
  "memory",
  "reminders",
  "webSearch",
  "webFetch",
  "browser",
  "documents",
  "readPdfs",
  "createImages",
  "skills",
  "shell",
  "ssh",
  "projects",
  "github",
]);
const memberEditKeys = new Set([
  "name",
  "role",
  "assignment",
  "extraInstructions",
  "instructions",
]);
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
  // MCP package installs of an MCP server (resourceType "mcp", the server's id).
  "package",
  // Live dictation in the composers: that it was used and for how long, never audio.
  "speech",
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
  "reinstalled",
  "detached",
  "executed",
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
  "startupTimeoutSec",
  "toolTimeoutSec",
  "env",
  "headers",
  "mcpServers",
  "clis",
  "heartbeat",
]);
// MCP package references (package-spec.js validated them before the install): the
// registry, an npm or PyPI name, an exact version and the canonical constraint lines.
// The limits of package-spec.js: npm versions up to 256 characters, a constraint line
// up to 100 (one specifier may use nearly all of it).
const packageRegistries = ["npm", "pypi"];
const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]{0,213}$/;
const packageVersion = /^[0-9][0-9A-Za-z.+!-]{0,255}$/;
const specifier = String.raw`(?:==|!=|~=|<=|>=|<|>)[0-9][0-9a-z.*!]{0,97}`;
const constraintLine = new RegExp(
  String.raw`^[a-z0-9][a-z0-9._-]{0,99}${specifier}(?:,${specifier}){0,9}$`,
);
function packageDetails(details, event) {
  if (packageRegistries.includes(details.registry)) {
    event.details.registry = details.registry;
    if (typeof details.name === "string" && packageName.test(details.name))
      event.details.name = details.name;
    if (typeof details.version === "string" && packageVersion.test(details.version))
      event.details.version = details.version;
  }
  if (typeof details.allowScripts === "boolean")
    event.details.allowScripts = details.allowScripts;
  if (Array.isArray(details.constraints) && details.constraints.length <= 10)
    event.details.constraints = details.constraints.filter(
      (line) =>
        typeof line === "string" && line.length <= 100 && constraintLine.test(line),
    );
}
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
  // A project merge names the older project it moved into the audited one; an agent
  // whose grants lost that older project names it too (assistant-workflows.js).
  if (
    (input.resourceType === "project" ||
      (input.resourceType === "assistant" && details.kind === "project-rebind")) &&
    details.fromProjectId !== undefined
  )
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
      "telegram",
      "ssh",
      "ssh-grants",
      "project-rebind",
      "member-grant",
      "member-reminder",
      "member-edit",
      "member-promote",
      "project-file",
      "project-grants",
      "lead-routine",
      "native-write",
      "share",
      "github-access",
      "generated-image",
      "image-generation",
      "attachment-clear",
      "dictation",
      "skill-import",
      "spec",
      "risk",
      "risk-rules",
      "budget",
      "queue",
      "queue-settings",
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
  // An agent's skill assignment names the bundled skills, public catalog names.
  if (Array.isArray(details.skills) && details.skills.length <= 64)
    event.details.skills = details.skills.filter(
      (name) => typeof name === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name),
    );
  // An agent's own Telegram bot names what changed; never a token, id or name.
  if (
    [
      "connected",
      "disconnected",
      "botReplaced",
      "tokenReplaced",
      "peopleAdded",
      "peopleRemoved",
      "updated",
    ].includes(details.telegram)
  )
    event.details.telegram = details.telegram;
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
    if (
      [
        "checks-follow",
        "skips-checks",
        "gate-decision",
        "members-pass",
        "accepts-changes",
      ].includes(details.path)
    )
      event.details.path = details.path;
    // A group override names the members it accepted without a verdict.
    if (Array.isArray(details.members))
      event.details.members = details.members.slice(0, 8).map((id) => auditId(id));
    // A replaced run spec names the hash of the owner's text.
    if (typeof details.sha256 === "string" && /^[a-f0-9]{64}$/.test(details.sha256))
      event.details.sha256 = details.sha256;
    // A raised token budget names the old and new budget and the tokens used so far.
    if (details.kind === "budget")
      for (const key of ["from", "to", "usedTokens"]) {
        const value = details[key];
        const max = key === "usedTokens" ? Number.MAX_SAFE_INTEGER : MAX_TOKEN_BUDGET;
        if (Number.isSafeInteger(value) && value >= 0 && value <= max)
          event.details[key] = value;
      }
    // A started run names the token budget it spends against and who set it.
    if (input.action === "pipeline.started") {
      const budget = details.tokenBudget;
      if (
        budget === null ||
        (Number.isSafeInteger(budget) && budget >= 1 && budget <= MAX_TOKEN_BUDGET)
      )
        event.details.tokenBudget = budget;
      if (["start", "pipeline"].includes(details.tokenBudgetSource))
        event.details.tokenBudgetSource = details.tokenBudgetSource;
    }
    // Queue settings name the concurrent runs and whether waiting runs count.
    if (details.kind === "queue-settings") {
      if (
        Number.isSafeInteger(details.limit) &&
        details.limit >= 1 &&
        details.limit <= MAX_QUEUE_CONCURRENCY
      )
        event.details.limit = details.limit;
      if (typeof details.countParked === "boolean")
        event.details.countParked = details.countParked;
    }
    // An approved risk gate names the repository paths it covered, never content.
    if (Array.isArray(details.paths))
      event.details.paths = details.paths
        .filter(
          (file) =>
            typeof file === "string" &&
            file.length <= 1024 &&
            !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(file),
        )
        .slice(0, 200);
  }
  // MCP OAuth logins name why one failed, as a stable code (never state or code).
  if (
    input.resourceType === "mcp" &&
    typeof details.failReason === "string" &&
    /^[a-z]+(?:-[a-z]+){0,4}$/.test(details.failReason)
  )
    event.details.failReason = details.failReason;
  // Brokered CLI logins name the managed account they logged in.
  if (input.resourceType === "mcp" && details.accountId !== undefined)
    event.details.accountId = auditId(details.accountId);
  for (const key of ["requestedBy", "teamId", "leadAssistantId"])
    if (details[key] !== undefined) event.details[key] = auditId(details[key]);
  // A lead's grant to a team member names the kinds it changed, never names.
  // A lead's edit of its member names the fields it changed, never their text.
  if (details.kind === "member-edit" && Array.isArray(details.edited))
    event.details.edited = details.edited.filter((key) => memberEditKeys.has(key));
  if (details.kind === "member-grant") {
    if (["grant", "revoke"].includes(details.change))
      event.details.change = details.change;
    if (Array.isArray(details.grants))
      event.details.grants = details.grants.filter((key) => memberGrantKeys.has(key));
  }
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
    // How the owner set a new server up; never what it holds.
    if (MCP_SERVER_ORIGINS.includes(details.origin))
      event.details.origin = details.origin;
    packageDetails(details, event);
  }
  // Advanced OpenClaw settings (advanced-config.js) name the setting and its old and
  // new value, kept only as that setting's own scalar type (null: unset).
  if (input.resourceType === "setting" && advancedSettingById(details.setting)) {
    event.details.setting = details.setting;
    for (const key of ["from", "to"])
      if (auditableSettingValue(details.setting, details[key]))
        event.details[key] = details[key];
  }
  // Agent proactivity changes name the switched opt-in as a flag (proactivity-changes.js).
  if (input.resourceType === "assistant" && typeof details.heartbeat === "boolean")
    event.details.heartbeat = details.heartbeat;
  for (const key of ["enabled", "pending"])
    if (typeof details[key] === "boolean") event.details[key] = details[key];
  if (["0.0.0.0", "::"].includes(details.bind)) event.details.bind = details.bind;
  for (const key of ["statusCode", "count", "revision", "skipped", "seconds"])
    if (Number.isSafeInteger(details[key]) && details[key] >= 0 && details[key] <= 1e9)
      event.details[key] = details[key];
  if (
    typeof details.version === "string" &&
    /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.-]{1,40})?$/.test(details.version)
  )
    event.details.version = details.version;
  // An agent's GitHub access (agent-github.js): the profile id and the levels, never
  // a token or the profile's name.
  if (details.kind === "github-access") {
    for (const key of ["githubFrom", "githubTo"])
      if (["none", "read", "write"].includes(details[key]))
        event.details[key] = details[key];
    if (details.credentialId !== undefined)
      event.details.credentialId = auditId(details.credentialId);
  }
  // An agent's change in a project folder: the relative path and size, never content.
  if (details.kind === "project-file") {
    if (["create", "replace", "edit", "append"].includes(details.fileChange))
      event.details.fileChange = details.fileChange;
    if (
      typeof details.filePath === "string" &&
      details.filePath.length <= 1024 &&
      !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(details.filePath)
    )
      event.details.filePath = details.filePath;
    if (Number.isSafeInteger(details.bytes) && details.bytes >= 0)
      event.details.bytes = details.bytes;
  }
  // The owner cleared an agent's attachments folder: how many entries and bytes.
  if (
    details.kind === "attachment-clear" &&
    Number.isSafeInteger(details.bytes) &&
    details.bytes >= 0
  )
    event.details.bytes = details.bytes;
  // An agent's project grants and folder levels: project ids and levels only.
  if (details.kind === "project-grants") {
    const ids = (value) =>
      Array.isArray(value) && value.length <= 100
        ? value.filter(
            (id) =>
              typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id),
          )
        : [];
    event.details.added = ids(details.added);
    event.details.removed = ids(details.removed);
    const levels = ["none", "read", "write"];
    if (Array.isArray(details.folderChanged) && details.folderChanged.length <= 100)
      event.details.folderChanged = details.folderChanged
        .filter(
          (c) =>
            ids([c?.projectId]).length === 1 &&
            levels.includes(c.from) &&
            levels.includes(c.to),
        )
        .map(({ projectId, from, to }) => ({ projectId, from, to }));
  }
  // A skill import names the scan verdict, how it arrived and the rules that found
  // something (skill-scan.js); never a path, excerpt or file content.
  if (input.resourceType === "extension") {
    if (SCAN_VERDICTS.includes(details.verdict)) event.details.verdict = details.verdict;
    if (["zip", "skill-md", "github"].includes(details.importKind))
      event.details.importKind = details.importKind;
    if (Array.isArray(details.scanRules))
      event.details.scanRules = SCAN_RULES.filter((rule) =>
        details.scanRules.includes(rule),
      );
  }
  // How a lead's team acted: routines, follow-up writes, shared folders.
  if (input.resourceType === "assistant") teamAuditDetails(details, event, auditId);
  // Agent SSH runs, refusals and grant changes (audit-ssh-details.js).
  if (input.resourceType === "ssh" || details.kind === "ssh-grants")
    sshAuditDetails(details, event, auditId);
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
