import React, { useId } from "react";
import { mcpWizardCopy as copy } from "../../../lib/i18n/messages/mcp-wizard.js";

const label = (value) =>
  value.field === "env"
    ? value.name
    : value.field === "args"
      ? copy.overview.argumentLabel(value.index + 1)
      : copy.overview.cwdLabel;

/**
 * A server with agent placeholders: what they resolve to for each bound agent and
 * whether that agent's own server runs (docs/mcp.md#agent-placeholders).
 */
export default function AgentFoldersCard({ server }) {
  const id = useId();
  const agents = server.agentFolders ?? [];
  return (
    <section className="mcp-step-card" aria-labelledby={id}>
      <h3 id={id}>{copy.overview.agentFoldersTitle}</h3>
      <p className="mcp-hint">{copy.overview.agentFoldersHint}</p>
      {agents.length ? (
        <ul className="mcp-agent-folders">
          {agents.map((agent) => (
            <li key={agent.id}>
              <p>
                {copy.overview.agentFolderLine(
                  agent.name,
                  copy.overview.agentFolderStates[agent.status] ?? agent.status,
                )}
              </p>
              {agent.values.map((value) => (
                <p
                  key={`${value.field}-${value.name ?? value.index ?? ""}`}
                  className="mcp-hint mcp-wizard-mono"
                >
                  {label(value)} = {value.value}
                </p>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mcp-hint">{copy.overview.agentFoldersNone}</p>
      )}
    </section>
  );
}
