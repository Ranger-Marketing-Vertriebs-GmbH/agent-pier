import React from "react";
import Icon from "../../components/Icon.jsx";
import Skeleton from "../../components/Skeleton.jsx";
import StatusChip from "../../components/StatusChip.jsx";
import StatusDot from "../../components/StatusDot.jsx";
import useAssistants from "../assistants/useAssistants.js";
import { avatarGlyph } from "../assistants/avatar-glyph.js";
import { serviceDown } from "../assistants/hub/hub-model.js";
import { assistantCopy } from "../../lib/i18n/messages/assistants.js";
import { agentsHubCopy } from "../../lib/i18n/messages/agents-hub.js";
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

// Skeleton rows in the shape of the agent rows.
function SkeletonRows({ count }) {
  return (
    <ul className="start-rows">
      {Array.from({ length: count }, (_, index) => (
        <li key={index}>
          <span className="start-row start-agent-row">
            <Skeleton shape="circle" width="32px" height="32px" />
            <span className="start-row-text">
              <strong>
                <Skeleton width="45%" />
              </strong>
              <small>
                <Skeleton width="65%" />
              </small>
            </span>
            <span className="status-chip">
              <Skeleton width="4em" />
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// Agents turned out to be off after the card was already in place: it stays and
// says so, with the way to turn them on.
function AgentsOff({ navigate }) {
  return (
    <section
      className="start-card start-list start-agents"
      aria-labelledby="start-agents-title"
    >
      <div className="start-card-head">
        <h2 id="start-agents-title">{copy.agents}</h2>
      </div>
      <div className="start-list-body">
        <p className="start-empty">{agentsHubCopy.off.title}</p>
      </div>
      <div className="start-card-foot">
        <button
          type="button"
          className="button secondary compact"
          onClick={() => navigate({ view: "agents" })}
        >
          {agentsHubCopy.off.enable}
          <Icon name="arrow" size={14} />
        </button>
      </div>
    </section>
  );
}

/**
 * The agents with their team note, current activity and state; needing you first.
 * The footer names the agent service's state. Until the first list arrives, skeleton
 * rows in the remembered `shape` hold its place (no "No agent yet" meanwhile); `off`
 * when agents turned out to be off while the card already showed.
 */
export default function AgentsCard({ navigate, phone, shape = null, off = false }) {
  const data = useAssistants();
  const open = useOpenAgent(navigate);
  if (off) return <AgentsOff navigate={navigate} />;
  if (!data.loaded)
    return (
      <StartListCard
        id="start-agents"
        className="start-agents"
        title={copy.agents}
        filters={agentFilters}
        filterLabels={copy.agentFilters}
        filterDots={dots}
        chipsLabel={copy.agentsFilter}
        searchLabel={copy.agentsSearch}
        limit={AGENT_LIMIT}
        footer
        phone={phone}
        loading
        shape={shape}
        placeholder={(count) => <SkeletonRows count={count} />}
      />
    );
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
          ? copy.agentsSummary(count("needsYou"), count("working")) || null
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
        <p className="start-card-note">
          <StatusDot tone={service.tone} />
          {service.text}
        </p>
      }
      error={open.error}
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
