import React from "react";
import SshCopy from "./SshCopy.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";

const reasons = {
  "no-openssh": () => copy.agentNoOpenSsh,
  "openssh-too-old": () => copy.agentTooOld,
  failed: () => copy.agentFailed,
  "not-eligible": () => copy.agentNotEligible,
};

// Codes of ssh-user-config.js, shown as a short reason (also AgentSshAgentStatus).
export const configReasons = {
  SSH_CONFIG_LINK: "link",
  SSH_CONFIG_NOT_FILE: "notFile",
  SSH_CONFIG_UNREADABLE: "unreadable",
  SSH_CONFIG_BLOCK_DAMAGED: "damaged",
  SSH_CONFIG_PATH_UNSUPPORTED: "path",
  SSH_CONFIG_WRITE_FAILED: "write",
  SSH_CONFIG_CHANGED: "changed",
  SSH_CONFIG_CHECK_FAILED: "check",
};

/**
 * The session's SSH agent (GET /sessions/:id/ssh-accesses `agent`, live through
 * `job.ssh-tools`): one status line and, while it is ready, a note when ~/.ssh/config
 * could not take AgentPier's block and a copyable `ssh <alias>` (`sftp <alias>` for an
 * SFTP host) per host that has an alias, in the order of `accesses`.
 */
export default function SessionSshAgentStatus({ agent, accesses = [] }) {
  if (!agent) return null;
  const ready = agent.state === "ready";
  const aliases = ready ? agent.aliases || {} : {};
  const names = new Map(accesses.map((access) => [access.id, access.name]));
  const sftp = new Set(
    accesses.filter((access) => access.type === "sftp").map((access) => access.id),
  );
  const ids = [
    ...accesses.map((access) => access.id).filter((id) => Object.hasOwn(aliases, id)),
    ...Object.keys(aliases).filter((id) => !names.has(id)),
  ];
  const rows = ids.map((id) => [id, aliases[id]]);
  return (
    <div className="ssh-agent-status">
      <p
        className={`dialog-status dialog-status-${ready ? "ok" : "neutral"}`}
        role="status"
      >
        {ready ? copy.agentReady : (reasons[agent.reason] || reasons["not-eligible"])()}
      </p>
      {ready && agent.sshConfig && (
        <p className="dialog-hint">
          {agent.sshConfig === "SSH_CONFIG_SESSION_LEFT_OUT"
            ? copy.agentSshConfigSession
            : copy.agentSshConfig(
                copy.agentSshConfigReasons[configReasons[agent.sshConfig] || "other"],
              )}
        </p>
      )}
      {rows.map(([id, alias]) => (
        <SshCopy
          key={id}
          label={names.get(id) || alias}
          text={(sftp.has(id) ? copy.agentSftpAliasLabel : copy.agentAliasLabel)(alias)}
          button={copy.copyCommand}
        />
      ))}
    </div>
  );
}
