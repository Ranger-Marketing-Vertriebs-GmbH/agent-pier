import React, { useState } from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { formatNumber, formatTimestamp } from "../../lib/i18n/index.js";
import { sessionActivity } from "../sessions/sessionPresentation.js";

const formatUsage = (value) => formatNumber(value, { maximumFractionDigits: 1 });
const tokenCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
export default function ChatObservability({
  session,
  observability,
  showSubagents,
  subagents = [],
}) {
  const [expanded, setExpanded] = useState(false);
  const activity = sessionActivity(session),
    context = observability?.context || {};
  const used = tokenCount(context.usedTokens),
    limit = tokenCount(context.limitTokens);
  const remaining =
    typeof context.remainingPercent === "number" &&
    Number.isFinite(context.remainingPercent)
      ? context.remainingPercent
      : null;
  const source =
    context.source === "last-api-request"
      ? copy.lastRequest
      : context.source === "native-token-count"
        ? copy.nativeUsage
        : copy.unknownSource;
  const limitSource =
    context.limitSource === "configured"
      ? copy.configuredLimit
      : context.limitSource === "native"
        ? copy.nativeLimit
        : copy.unspecifiedLimit;
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
      <div
        className="chat-context-budget"
        role="group"
        aria-label={copy.context}
        title={context.observedAt ? formatTimestamp(context.observedAt) : undefined}
      >
        <span>
          {used === null ? copy.unknownUsage : `${source}: ${formatUsage(used)}`}
        </span>
        {limit !== null && limit > 0 && (
          <span>
            {limitSource}: {formatUsage(limit)}
          </span>
        )}
        {remaining !== null && <span>{copy.remaining(formatUsage(remaining))}</span>}
        {observability?.stale && <span>{copy.stale}</span>}
      </div>
      {subagents.length > 0 && (
        <button type="button" aria-label={copy.showSubagents} onClick={showSubagents}>
          {copy.subagentCount(subagents.length)}
        </button>
      )}
    </div>
  );
}
