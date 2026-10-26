import React, { useId } from "react";
import CheckRow from "../../components/CheckRow.jsx";
import Segmented from "../../components/Segmented.jsx";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";

/** The agents a bulk grant or revoke applies to, with one mode for all of them. */
export default function AgentChoice({
  agents,
  chosen,
  onChange,
  modes,
  mode,
  onMode,
  modeLabel = copy.bulk.mode,
  sub,
}) {
  const id = useId();
  const toggle = (agentId, on) =>
    onChange(on ? [...chosen, agentId] : chosen.filter((value) => value !== agentId));
  return (
    <div className="connections-agent-choice">
      <fieldset>
        <legend id={`${id}-agents`}>{copy.bulk.agents}</legend>
        {agents.length ? (
          <div className="connections-agent-list">
            {agents.map((agent) => (
              <CheckRow
                key={agent.id}
                title={agent.name}
                subtitle={sub?.(agent)}
                checked={chosen.includes(agent.id)}
                onChange={(event) => toggle(agent.id, event.target.checked)}
              />
            ))}
          </div>
        ) : (
          <p className="accounts-note">{copy.usedBy.noCandidates}</p>
        )}
      </fieldset>
      {modes && (
        <div className="connections-agent-mode">
          <span>{modeLabel}</span>
          <Segmented label={modeLabel} value={mode} onChange={onMode} options={modes} />
        </div>
      )}
    </div>
  );
}
