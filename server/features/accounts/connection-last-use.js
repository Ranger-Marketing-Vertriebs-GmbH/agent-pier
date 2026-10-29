/**
 * Audit actions that record a use of an SSH/SFTP host, read for "last used". The audit
 * holds agents' SSH commands (agent-ssh.js), every SFTP transfer of agents and
 * sessions (agent-sftp-runs.js, sftp-session-audit.js) and the signatures of a
 * session's SSH agent (ssh.connected, ssh-agent-audit.js), so plain ssh, scp, rsync and
 * git through the agent count. A coding session's ssh_execute calls through the ssh.mjs
 * helper are not audited, so a host used only that way reads as never used:
 * `sshLastUseCovers` names what the time covers.
 */
export const sshUseActions = [
  "ssh.executed",
  "ssh.connected",
  "sftp.completed",
  "sftp.failed",
];
export const sshLastUseCovers = ["agentSsh", "agentSftp", "sessionSftp", "sessionSsh"];

/** Host id → ISO time of its newest recorded use; null when the audit cannot be read. */
export function sshLastUse(audit) {
  if (!audit?.latestByResource) return null;
  try {
    return audit.latestByResource(sshUseActions);
  } catch {
    return null;
  }
}

/** Audit actions that record a change of a central MCP server ("last changed"). */
export const mcpChangeActions = ["mcp.created", "mcp.updated"];

/** Server id → ISO time of its newest create or edit; null when unreadable. */
export function mcpLastChange(audit) {
  if (!audit?.latestByResource) return null;
  try {
    return audit.latestByResource(mcpChangeActions);
  } catch {
    return null;
  }
}
