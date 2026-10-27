import React from "react";
import { assistantWorkflowCopy as copy } from "../../lib/i18n/messages/assistant-workflows.js";
import "./exec-approval-card.css";

/**
 * What an agent's coding session start would launch with (session-start.js
 * launchSummary): the launch mode, flagged when the CLI runs unattended, the account
 * or connection and model, how many secrets and SSH accesses, the sandbox profile,
 * and whether the AgentPier tools and AgentBus are on. Names and counts only.
 */
export default function SessionLaunchFacts({ launch }) {
  if (!launch) return null;
  const c = copy.sessionLaunch;
  const onOff = (value) => (value ? c.on : c.off);
  const facts = [
    [c.mode, launch.launchMode],
    ...(launch.account ? [[c.account, launch.account]] : []),
    ...(launch.connection ? [[c.connection, launch.connection]] : []),
    ...(launch.model ? [[c.model, <code key="model">{launch.model}</code>]] : []),
    [c.secrets, String(launch.secrets)],
    [c.sshAccesses, String(launch.sshAccesses)],
    [c.sandbox, launch.sandbox || c.noSandbox],
    [c.agentpierTools, onOff(launch.agentpierTools)],
    [c.agentbus, onOff(launch.agentbus)],
  ];
  return (
    <>
      <dl className="exec-approval-facts" data-session-launch="">
        {facts.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {launch.unattended && <p className="exec-approval-note">{c.unattended}</p>}
    </>
  );
}
