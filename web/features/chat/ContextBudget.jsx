import React from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { formatNumber, formatTimestamp } from "../../lib/i18n/index.js";
import { formatTokens, tokenCount, usedPercent } from "./token-presentation.js";

const sourceLabel = (source) =>
  source === "last-api-request"
    ? copy.lastRequest
    : source === "native-token-count"
      ? copy.nativeUsage
      : copy.unknownSource;
const limitLabel = (source) =>
  ({
    configured: copy.configuredLimit,
    native: copy.nativeLimit,
    "assumed-model": copy.assumedLimit,
  })[source] || copy.unspecifiedLimit;

/** Context row: bar, used / window, labels; a compaction shows only its size. */
export default function ContextBudget({ context = {}, stale = false }) {
  const used = tokenCount(context.usedTokens),
    limit = tokenCount(context.limitTokens);
  const remaining =
    typeof context.remainingPercent === "number" &&
    Number.isFinite(context.remainingPercent)
      ? context.remainingPercent
      : null;
  const percent = used !== null && limit ? usedPercent(context) : null;
  const compaction =
    used === null ? tokenCount(context.compaction?.conversationTokens) : null;
  return (
    <>
      {remaining !== null && limit > 0 && (
        <span
          className={`chat-context-chip${stale ? " stale" : ""}`}
          aria-hidden="true"
          title={stale ? copy.stale : undefined}
        >
          {copy.remaining(formatNumber(remaining, { maximumFractionDigits: 0 }))}
          {stale && <span className="chat-context-chip-stale">{copy.stale}</span>}
        </span>
      )}
      <div
        className="chat-context-budget"
        role="group"
        aria-label={copy.context}
        title={context.observedAt ? formatTimestamp(context.observedAt) : undefined}
      >
        {percent !== null && (
          <span
            className="chat-context-bar"
            role="meter"
            aria-label={copy.contextUsed}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
        <span>
          {used !== null
            ? `${sourceLabel(context.source)}: ${
                limit > 0
                  ? copy.usedOfWindow(formatTokens(used), formatTokens(limit))
                  : formatTokens(used)
              }`
            : compaction !== null
              ? copy.compaction(formatTokens(compaction))
              : copy.unknownUsage}
        </span>
        {limit > 0 && (
          <span>
            {used !== null
              ? limitLabel(context.limitSource)
              : `${limitLabel(context.limitSource)}: ${formatTokens(limit)}`}
          </span>
        )}
        {remaining !== null && (
          <span>
            {copy.remaining(formatNumber(remaining, { maximumFractionDigits: 1 }))}
          </span>
        )}
        {stale && <span>{copy.stale}</span>}
      </div>
    </>
  );
}
