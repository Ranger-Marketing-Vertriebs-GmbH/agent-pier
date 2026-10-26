/**
 * Audit actions that record a use of an SSH/SFTP host, read for "last used". The audit
 * holds agents' SSH commands (agent-ssh.js) and every SFTP transfer of agents and
 * sessions (agent-sftp-runs.js, sftp-session-audit.js). A coding session's own SSH
 * commands run through the ssh.mjs helper and are not audited, so a host used only
 * that way reads as never used: `sshLastUseCovers` names what the time covers.
 */
export const sshUseActions = ["ssh.executed", "sftp.completed", "sftp.failed"];
export const sshLastUseCovers = ["agentSsh", "agentSftp", "sessionSftp"];

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
