import React from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
import {
  subagentHeading,
  subagentStatus,
  subagentStatusLabel,
} from "./subagent-presentation.js";
import { usageSummary } from "./token-presentation.js";
export default function SubagentList({ subagents = [] }) {
  if (!subagents.length) return null;
  return (
    <section className="chat-subagents" aria-label={copy.subagents}>
      <h3>{subagentHeading(subagents)}</h3>
      {subagents.map((agent) => {
        const usage = usageSummary(agent.usage);
        return (
          <article
            className={`subagent-entry${agent.fading ? " fading" : ""}`}
            key={agent.id}
          >
            <div className="subagent-heading">
              <span>{agent.name || agent.id}</span>
              <small className={`subagent-status ${subagentStatus(agent)}`}>
                {subagentStatusLabel(agent.status)}
              </small>
            </div>
            <p>{agent.task || copy.noTask}</p>
            {usage && <small className="subagent-usage">{usage}</small>}
            {agent.updatedAt && (
              <time dateTime={agent.updatedAt}>{formatTimestamp(agent.updatedAt)}</time>
            )}
          </article>
        );
      })}
    </section>
  );
}
