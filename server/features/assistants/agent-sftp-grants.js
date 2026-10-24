import { approvalRevision } from "./assistant-access.js";

/**
 * "Always allow" on an SFTP card: the holder's grant for that host goes from
 * `approval` to `trusted`, so its later uploads, overwrites, folders, renames and
 * syncs without deletes run without a card (deletes still ask, agent-sftp-policy.js).
 * A grant already `trusted` or `routines` stays as it is. Like a host removal
 * (AssistantAccess.revokeEach) it keeps the approval revision, so other open
 * approvals stay valid; the change is audited as `ssh-grants` with reason
 * `always-allow`. Returns whether the grant changed.
 */
export function alwaysAllowSftp(access, holderId, accessId) {
  const before = access.get(holderId);
  const grant = before.sshAccesses.find((g) => g.accessId === accessId);
  if (!grant || grant.mode !== "approval") return false;
  const after = access.write(holderId, {
    ...before,
    sshAccesses: before.sshAccesses.map((g) =>
      g.accessId === accessId ? { ...g, mode: "trusted" } : g,
    ),
    revision: before.revision + 1,
    approvalRevision: approvalRevision(before),
  });
  access.auditSsh(holderId, before, after, "always-allow");
  access.s.assistants.changed();
  return true;
}
