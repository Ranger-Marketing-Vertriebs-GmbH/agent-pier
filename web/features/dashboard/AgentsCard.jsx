import React from "react";
import ErrorMessage from "../../components/ErrorMessage.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import useAssistants from "../assistants/useAssistants.js";
import { avatarGlyph } from "../assistants/avatar-glyph.js";
import { serviceDown } from "../assistants/hub/hub-model.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { startPageCopy as copy } from "../../lib/i18n/messages/dashboard.js";
import StartListCard from "./StartListCard.jsx";
import { agentFilters, AGENT_LIMIT } from "./start-lists.js";
import { startAgents } from "./start-agents.js";
import useOpenAgent from "./useOpenAgent.js";

const chipTones = {
  needsYou: "waiting",
  working: "running",
  ready: "ok",
  offline: "neutral",
};
const dots = { needsYou: "waiting", working: "working", ready: "ok" };

function serviceLine(runtime) {
  if (runtime?.availability === "ready") return { tone: "ok", text: copy.service.ready };
  if (serviceDown(runtime)) return { tone: "error", text: copy.service.down };
  return { tone: "pending", text: copy.service.other };
}

/**
 * The agents with their team note, current activity and state; needing you first.
 * The footer names the agent service's state. Absent while agents are off.
 */
export default function AgentsCard({ navigate, phone }) {
  const data = useAssistants();
  const open = useOpenAgent(navigate);
  const items = startAgents({ ...data, copy: assistantCopy });
  const service = serviceLine(data.runtime);
  const count = (state) => items.filter((item) => item.state === state).length;
  return (
    <StartListCard
      id="start-agents"
      className="start-agents"
      title={copy.agents}
      count={
        phone
          ? copy.agentsSummary(count("needsYou"), count("working")) || items.length
          : items.length || null
      }
      items={items}
      filters={agentFilters}
      filterLabels={copy.agentFilters}
      filterDots={dots}
      chipsLabel={copy.agentsFilter}
      searchLabel={copy.agentsSearch}
      limit={AGENT_LIMIT}
      order={copy.agentOrder}
      empty={copy.noAgents}
      noMatch={copy.noAgentMatch}
      phone={phone}
      footer={
        <>
          <p className="start-card-note">
            <StatusDot tone={service.tone} />
            {service.text}
          </p>
          <ErrorMessage error={open.error} />
        </>
      }
      showAll={(total) => ({
        label: copy.showAllAgents(total),
        onClick: () => navigate({ view: "agents" }),
      })}
    >
      {(rows) => (
        <ul className="start-rows">
          {rows.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="start-row start-agent-row"
                disabled={open.busy === item.id}
                onClick={() => open.run(item.assistant)}
              >
                <span className="start-avatar" aria-hidden="true">
                  {avatarGlyph(item.name)}
                </span>
                <span className="start-row-text">
                  <strong>
                    {item.name}
                    {item.team && !phone && (
                      <small className="start-team-note">
                        {" · "}
                        {copy.team[item.team.kind](item.team.count)}
                      </small>
                    )}
                  </strong>
                  {item.line && <small>{item.line}</small>}
                </span>
                <StatusChip tone={chipTones[item.state]}>{item.label}</StatusChip>
              </button>
            </li>
          ))}
        </ul>
      )}
    </StartListCard>
  );
}
