// Agent SSH audit details (agent-ssh.js, assistant-access.js): ids, the outcome and
// a digest. Never the command text, its output or key material.
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;
const modes = ["approval", "trusted", "routines"];
const isId = (value) => typeof value === "string" && idPattern.test(value);

export function sshAuditDetails(details, event, auditId) {
  for (const key of ["assistantId", "accessId", "leadAssistantId", "proposalId"])
    if (details[key] !== undefined) event.details[key] = auditId(details[key]);
  // An owner-chosen catalog name; control characters could forge log lines.
  if (
    typeof details.hostName === "string" &&
    /^[^\u0000-\u001f\u007f-\u009f]{1,200}$/.test(details.hostName)
  )
    event.details.hostName = details.hostName;
  if (["owner", "delegated", "routine", "hook", "refused"].includes(details.originClass))
    event.details.originClass = details.originClass;
  if (["approval", "mode"].includes(details.authorizedBy))
    event.details.authorizedBy = details.authorizedBy;
  if (modes.includes(details.mode)) event.details.mode = details.mode;
  if (
    Number.isSafeInteger(details.exitCode) &&
    details.exitCode >= 0 &&
    details.exitCode <= 255
  )
    event.details.exitCode = details.exitCode;
  if (typeof details.signal === "string" && /^SIG[A-Z0-9]{1,10}$/.test(details.signal))
    event.details.signal = details.signal;
  for (const key of ["timedOut", "truncated", "revoked", "interactive"])
    if (typeof details[key] === "boolean") event.details[key] = details[key];
  if (
    Number.isSafeInteger(details.durationMs) &&
    details.durationMs >= 0 &&
    details.durationMs <= 86400000
  )
    event.details.durationMs = details.durationMs;
  if (
    typeof details.commandSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(details.commandSha256)
  )
    event.details.commandSha256 = details.commandSha256;
  if (
    Number.isSafeInteger(details.commandBytes) &&
    details.commandBytes >= 0 &&
    details.commandBytes <= 16384
  )
    event.details.commandBytes = details.commandBytes;
  if (typeof details.code === "string" && /^SSH_[A-Z_]{2,40}$/.test(details.code))
    event.details.code = details.code;
  for (const key of ["added", "removed"])
    if (Array.isArray(details[key]) && details[key].length <= 30)
      event.details[key] = details[key].filter(isId);
  if (Array.isArray(details.modeChanged) && details.modeChanged.length <= 30)
    event.details.modeChanged = details.modeChanged
      .filter((c) => isId(c?.accessId) && modes.includes(c.from) && modes.includes(c.to))
      .map(({ accessId, from, to }) => ({ accessId, from, to }));
  if (["owner", "host-removed", "always-allow", "proposal"].includes(details.reason))
    event.details.reason = details.reason;
}
