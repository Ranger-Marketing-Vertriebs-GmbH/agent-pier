import React from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/de/chat-observability.js";
import { formatTimestamp } from "../../lib/i18n/index.js";
const labels = {
  running: copy.running,
  completed: copy.completed,
  failed: copy.failed,
  unknown: copy.unknown,
};
export default function SubagentList({ subagents = [] }) {
  if (!subagents.length) return null;
  return (
    <section className="chat-subagents" aria-label={copy.subagents}>
      <h3>{copy.subagentCount(subagents.length)}</h3>
      {subagents.map((agent) => (
        <details className="subagent-entry" key={agent.id}>
          <summary>
            <span>{agent.name || agent.id}</span>
            <small className={`subagent-status ${agent.status}`}>
              {labels[agent.status] || copy.unknown}
            </small>
          </summary>
          <p>{agent.task || copy.noTask}</p>
          {agent.updatedAt && (
            <time dateTime={agent.updatedAt}>{formatTimestamp(agent.updatedAt)}</time>
          )}
        </details>
      ))}
    </section>
  );
}
