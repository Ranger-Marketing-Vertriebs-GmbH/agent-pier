import { serverMessages } from "../../lib/i18n/de.js";
import { sshProblem } from "../ssh/ssh-errors.js";

// The coding sessions' SFTP audit rows. The session MCP process cannot write the
// audit log; it reports each finished transfer or write over the management socket
// and the application appends the row (`audit-sftp-details.js` keeps only safe facts).
export const sftpRecordFields = [
  "accessId",
  "operation",
  "direction",
  "state",
  "files",
  "bytes",
  "deleted",
  "dirs",
  "durationMs",
  "remotePath",
  "localPath",
  "code",
];
const operations = ["download", "upload", "sync", "mkdir", "rename", "delete"];
const states = ["completed", "failed", "cancelled", "revoked"];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

function sftpHost(management, accessId) {
  try {
    return management.store.get(accessId).type === "sftp";
  } catch {
    return false;
  }
}

/**
 * Appends `sftp.completed` or `sftp.failed` for an SFTP host in the session's
 * effective grants. A job stopped because its grant was revoked is no longer granted
 * when it reports, so `state: "revoked"` is accepted for any existing SFTP host. A
 * record for an existing host the session was never granted is appended as
 * `sftp.denied` and refused; an unknown id is refused without a row. Every row is
 * marked `reported: "session"`: the session MCP process states its counts and
 * paths, the application only checks the session and the grant.
 */
export async function recordSessionSftp(management, context, input) {
  const { accessId, operation, state } = input;
  if (
    typeof accessId !== "string" ||
    !idPattern.test(accessId) ||
    !operations.includes(operation) ||
    !states.includes(state)
  )
    throw sshProblem("SSH_INVALID_ARGUMENT", serverMessages.ssh.sftpRecordInvalid);
  const refused = () =>
    sshProblem("SSH_WRONG_PROJECT", serverMessages.ssh.sftpNotAssigned, 403);
  if (!sftpHost(management, accessId)) throw refused();
  const row = {
    resourceType: "ssh",
    resourceId: accessId,
    source: "mcp",
    sessionId: context.session.id,
    projectId: context.project.projectId,
  };
  const details = { ...input, reported: "session" };
  const effective = await management.grants.effective(context.session);
  if (!effective.includes(accessId) && state !== "revoked") {
    management.audit?.append({
      ...row,
      action: "sftp.denied",
      outcome: "failure",
      details: { ...details, code: "SSH_WRONG_PROJECT" },
    });
    throw refused();
  }
  const completed = state === "completed";
  management.audit?.append({
    ...row,
    action: completed ? "sftp.completed" : "sftp.failed",
    outcome: completed ? "success" : "failure",
    details: completed ? details : { ...details, code: input.code ?? "SFTP_FAILED" },
  });
  return { recorded: true };
}
