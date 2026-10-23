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
  "durationMs",
  "remotePath",
  "localPath",
  "code",
];
const operations = ["download", "upload", "sync", "mkdir", "rename", "delete"];
const states = ["completed", "failed", "cancelled", "revoked"];
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

function grantedSftp(management, accessId, effective) {
  if (!effective.includes(accessId)) return false;
  try {
    return management.store.get(accessId).type === "sftp";
  } catch {
    return false;
  }
}

/**
 * Appends `sftp.completed` or `sftp.failed` for a host in the session's effective
 * grants; a record for any other host is appended as `sftp.denied` and refused.
 */
export async function recordSessionSftp(management, context, input) {
  const { accessId, operation, state } = input;
  if (
    typeof accessId !== "string" ||
    !idPattern.test(accessId) ||
    !operations.includes(operation) ||
    !states.includes(state)
  )
    throw sshProblem("SSH_INVALID_ARGUMENT", "Invalid SFTP record.");
  const row = {
    resourceType: "ssh",
    resourceId: accessId,
    source: "mcp",
    sessionId: context.session.id,
    projectId: context.project.projectId,
  };
  const effective = await management.grants.effective(context.session);
  if (!grantedSftp(management, accessId, effective)) {
    management.audit?.append({
      ...row,
      action: "sftp.denied",
      outcome: "failure",
      // A job revoked mid-run still reports what it did before it stopped.
      details: { ...input, code: input.code ?? "SSH_WRONG_PROJECT" },
    });
    throw sshProblem("SSH_WRONG_PROJECT", "SFTP host is not assigned.", 403);
  }
  const completed = state === "completed";
  management.audit?.append({
    ...row,
    action: completed ? "sftp.completed" : "sftp.failed",
    outcome: completed ? "success" : "failure",
    details: { ...input },
  });
  return { recorded: true };
}
