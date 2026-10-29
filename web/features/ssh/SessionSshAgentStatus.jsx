import React from "react";
import SshCopy from "./SshCopy.jsx";
import { sshCopy as copy } from "../../lib/i18n/messages/ssh.js";

const reasons = {
  "no-openssh": () => copy.agentNoOpenSsh,
  "openssh-too-old": () => copy.agentTooOld,
  failed: () => copy.agentFailed,
  "not-eligible": () => copy.agentNotEligible,
};

/**
 * The session's SSH agent (GET /sessions/:id/ssh-accesses `agent`, live through
 * `job.ssh-tools`): one status line and, while it is ready, a note when ~/.ssh/config
 * could not take AgentPier's block and a copyable `ssh <alias>` per host that has an
 * alias, in the order of `accesses`.
 */
export default function SessionSshAgentStatus({ agent, accesses = [] }) {
  if (!agent) return null;
  const ready = agent.state === "ready";
  const aliases = ready ? agent.aliases || {} : {};
  const names = new Map(accesses.map((access) => [access.id, access.name]));
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
        <p className="dialog-hint">{copy.agentSshConfig(agent.sshConfig)}</p>
      )}
      {rows.map(([id, alias]) => (
        <SshCopy
          key={id}
          label={names.get(id) || alias}
          text={copy.agentAliasLabel(alias)}
          button={copy.copyCommand}
        />
      ))}
    </div>
  );
}
