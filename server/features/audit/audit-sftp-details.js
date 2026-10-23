// SFTP audit details (sftp-session-audit.js): ids, the operation, counts, bytes, the
// duration, the paths and a stable code. Never a password, key or file content.
// `reported: "session"` marks facts a coding session's MCP process reported itself
// (sftp-session-audit.js): the application checked the session and the grant, not
// the counts or paths.
const operations = ["download", "upload", "sync", "mkdir", "rename", "delete"];
const states = ["completed", "failed", "cancelled", "revoked"];
// Control characters and line separators could forge log lines.
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

export function sftpAuditDetails(details, event, auditId) {
  for (const key of ["assistantId", "accessId"])
    if (details[key] !== undefined) event.details[key] = auditId(details[key]);
  if (operations.includes(details.operation)) event.details.operation = details.operation;
  if (["up", "down"].includes(details.direction))
    event.details.direction = details.direction;
  if (states.includes(details.state)) event.details.state = details.state;
  if (details.reported === "session") event.details.reported = "session";
  for (const key of ["files", "dirs", "bytes", "deleted"])
    if (count(details[key])) event.details[key] = details[key];
  if (count(details.durationMs) && details.durationMs <= 86400000)
    event.details.durationMs = details.durationMs;
  for (const key of ["remotePath", "localPath"])
    if (
      typeof details[key] === "string" &&
      details[key].length >= 1 &&
      details[key].length <= 1024 &&
      !unsafe.test(details[key])
    )
      event.details[key] = details[key];
  if (typeof details.code === "string" && /^S(SH|FTP)_[A-Z_]{2,40}$/.test(details.code))
    event.details.code = details.code;
}
