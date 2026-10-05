import React from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { formatNumber, formatTimestamp } from "../../lib/i18n/index.js";
import { relativeTime } from "../projects/ProjectOverview.jsx";
import {
  formatTokens,
  formatUsd,
  lowerBoundShown,
  tokenCount,
  windowLabel,
} from "./token-presentation.js";

function totalsRows(totals) {
  const codex = typeof totals.source === "string" && totals.source.startsWith("codex-");
  return [
    [codex ? copy.inputInclCache : copy.input, totals.inputTokens, ""],
    [copy.output, totals.outputTokens, totals.outputIsLowerBound ? "≥" : ""],
    [copy.cacheRead, totals.cacheReadTokens, ""],
    [copy.cacheWrite, totals.cacheWriteTokens, ""],
    [copy.reasoning, totals.reasoningTokens, ""],
    [copy.total, totals.totalTokens, lowerBoundShown(totals) ? "≥" : ""],
  ].filter(([, value]) => tokenCount(value) !== null);
}

function Cost({ cost }) {
  const amount = formatUsd(cost?.usd);
  if (!amount) return null;
  return (
    <p className="chat-token-cost">
      {cost.scope === "cli-exit-incl-subagents" ? copy.costCliExit : copy.cost}: {amount}
    </p>
  );
}

function SubagentLine({ subagents }) {
  if (!subagents?.count && !subagents?.unavailable) return null;
  const tokens = formatTokens(subagents.totalTokens);
  const parts = [
    tokens === null
      ? copy.subagentUsageCount(subagents.count)
      : copy.subagentUsage(
          subagents.count,
          `${lowerBoundShown(subagents) ? "≥" : ""}${tokens}`,
        ),
  ];
  if (subagents.workflowAgents) parts.push(copy.workflowAgents);
  if (subagents.unavailable) parts.push(copy.unavailableAgents(subagents.unavailable));
  return <p className="chat-token-subagents">{parts.join(" · ")}</p>;
}

function Credits({ credits }) {
  if (credits?.unlimited) return <span>{copy.creditsUnlimited}</span>;
  if (credits?.hasCredits && credits.balance !== null)
    return <span>{copy.credits(credits.balance)}</span>;
  return null;
}

function Limits({ limits }) {
  if (!limits?.buckets?.length) return null;
  return (
    <section className="chat-token-limits" aria-label={copy.limits}>
      {limits.buckets.map((bucket) => {
        const name = [bucket.limitName || bucket.limitId, bucket.plan]
          .filter(Boolean)
          .join(" · ");
        return (
          <div className="chat-limit-bucket" key={bucket.limitId}>
            <strong>{name}</strong>
            {bucket.windows.map((window, index) => {
              const label = windowLabel(window.windowMinutes);
              const resets = Number.isSafeInteger(window.resetsAt)
                ? new Date(window.resetsAt).toISOString()
                : null;
              return (
                <div className="chat-limit-window" key={index}>
                  <span>{label}</span>
                  <span
                    className="chat-context-bar"
                    role="meter"
                    aria-label={copy.limitMeter(name, label)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={window.usedPercent}
                  >
                    <span style={{ width: `${window.usedPercent}%` }} />
                  </span>
                  <span>
                    {copy.limitUsed(
                      formatNumber(window.usedPercent, { maximumFractionDigits: 1 }),
                    )}
                  </span>
                  {resets && (
                    <time dateTime={resets} title={formatTimestamp(resets)}>
                      {copy.resets(relativeTime(resets))}
                    </time>
                  )}
                </div>
              );
            })}
            <Credits credits={bucket.credits} />
          </div>
        );
      })}
    </section>
  );
}

/** Session totals, cost, subagent share and Codex limits behind one disclosure. */
export default function TokenDetails({ totals, limits }) {
  const rows = totals ? totalsRows(totals) : [];
  if (!rows.length && !totals?.cost && !totals?.subagents && !limits?.buckets?.length)
    return null;
  return (
    <details className="chat-token-details">
      <summary>{copy.usage}</summary>
      {rows.length > 0 && (
        <table className="chat-token-totals" aria-label={copy.totals}>
          {totals.source === "codex-process" && <caption>{copy.processTotals}</caption>}
          <tbody>
            {rows.map(([label, value, prefix]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>
                  {prefix}
                  {formatTokens(value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Cost cost={totals?.cost} />
      <SubagentLine subagents={totals?.subagents} />
      <Limits limits={limits} />
    </details>
  );
}
