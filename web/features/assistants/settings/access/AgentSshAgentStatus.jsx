import React from "react";
import useLiveTopic from "../../../../lib/live/useLiveTopic.js";
import { assistantSshCopy } from "../../../../lib/i18n/messages/assistant-ssh.js";
import { sshCopy } from "../../../../lib/i18n/messages/ssh.js";
import SshCopy from "../../../ssh/SshCopy.jsx";
import { configReasons } from "../../../ssh/SessionSshAgentStatus.jsx";
import "../../../ssh/ssh.css";

const copy = assistantSshCopy.plain;

const reasons = {
  "no-shell": () => copy.noShell,
  "no-openssh": () => copy.noOpenSsh,
  "openssh-too-old": () => copy.tooOld,
  failed: () => copy.failed,
  "not-eligible": () => copy.notEligible,
};

/**
 * The agent's plain ssh (GET /assistants/:id/ssh-agent, live as
 * `agent.ssh-agent:<id>`): one status line and, while it is ready, a copyable
 * `ssh <alias>` per trusted host in the order of `hosts` (catalog entries, labelled
 * by name; a host the catalog does not list shows its command alone), the approval
 * hint when the saved grants hold an approval host (`approval`), and the note on
 * open connections. Nothing while loading or without SSH hosts.
 */
export default function AgentSshAgentStatus({ assistantId, hosts, approval = false }) {
  const { data } = useLiveTopic(assistantId ? `agent.ssh-agent:${assistantId}` : null);
  const ready = data?.state === "ready";
  if (!ready && !(data?.state === "unavailable" && reasons[data.reason])) return null;
  const aliases = ready ? data.aliases || {} : {};
  const known = hosts || [];
  const names = new Map(known.map((host) => [host.id, host.name]));
  const ids = [
    ...known.map((host) => host.id).filter((id) => Object.hasOwn(aliases, id)),
    ...Object.keys(aliases).filter((id) => !names.has(id)),
  ];
  return (
    <div className="ssh-agent-status" aria-label={copy.title} role="group">
      <p
        className={`dialog-status dialog-status-${ready ? "ok" : "neutral"}`}
        role="status"
      >
        {ready ? copy.ready : reasons[data.reason]()}
      </p>
      {ready && data.sshConfig && (
        <p className="dialog-hint">
          {copy.sshConfig(
            sshCopy.agentSshConfigReasons[configReasons[data.sshConfig] || "other"],
          )}
        </p>
      )}
      {ready && !ids.length && <p className="dialog-hint">{copy.readyNone}</p>}
      {ids.map((id) => (
        <SshCopy
          key={id}
          label={names.get(id)}
          text={copy.aliasLabel(aliases[id])}
          button={copy.copy}
        />
      ))}
      {ready && approval && <p className="dialog-hint">{copy.approvalHint}</p>}
      {ready && <p className="dialog-hint">{copy.openConnections}</p>}
    </div>
  );
}
