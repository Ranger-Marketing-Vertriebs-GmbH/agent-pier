import React, { useState } from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { sessionActivity } from "../sessions/sessionPresentation.js";
import { subagentHeading } from "./subagent-presentation.js";
import ContextBudget from "./ContextBudget.jsx";
import TokenDetails from "./TokenDetails.jsx";

export default function ChatObservability({
  session,
  observability,
  showSubagents,
  subagents = [],
}) {
  const [expanded, setExpanded] = useState(false);
  const activity = sessionActivity(session);
  return (
    <div className={`chat-observability${expanded ? " expanded" : ""}`}>
      <span className="chat-activity" role="status" aria-label={copy.activity}>
        <span
          className={
            activity.state === "working"
              ? "chat-working-spinner"
              : `activity-dot ${activity.state}`
          }
          aria-hidden="true"
        />
        {activity.label}
      </span>
      <button
        type="button"
        className="chat-context-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? copy.hideContext : copy.showContext}
        onClick={() => setExpanded((value) => !value)}
      >
        {copy.details} {expanded ? "⌃" : "⌄"}
      </button>
      <ContextBudget
        context={observability?.context || {}}
        stale={Boolean(observability?.stale)}
      />
      <TokenDetails totals={observability?.totals} limits={observability?.limits} />
      {subagents.length > 0 && (
        <button type="button" aria-label={copy.showSubagents} onClick={showSubagents}>
          {subagentHeading(subagents)}
        </button>
      )}
    </div>
  );
}
