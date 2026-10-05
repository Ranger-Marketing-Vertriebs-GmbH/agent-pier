import React, { useEffect, useState } from "react";
import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { formatNumber, formatTimestamp } from "../../lib/i18n/index.js";
import { relativeTime } from "../projects/ProjectOverview.jsx";
import {
  currentBuckets,
  formatTokens,
  formatUsd,
  lowerBoundShown,
  nextReset,
  totalsRows,
  windowLabel,
} from "./token-presentation.js";

const TICK = 30_000;

/**
 * Re-renders while the details are open: every 30 s for the relative reset times,
 * and at the next reset so its window disappears on time.
 */
function useLimitClock(open, buckets) {
  const [, setTick] = useState(0);
  const reset = open ? nextReset(buckets) : null;
  useEffect(() => {
    if (!open) return undefined;
    const wait = reset === null ? TICK : Math.min(TICK, Math.max(0, reset - Date.now()));
    const timer = setTimeout(() => setTick((value) => value + 1), wait);
    return () => clearTimeout(timer);
  });
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

function Limits({ buckets }) {
  if (!buckets.length) return null;
  return (
    <section className="chat-token-limits" aria-label={copy.limits}>
      {buckets.map((bucket) => {
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
  const [open, setOpen] = useState(false);
  const buckets = currentBuckets(limits);
  useLimitClock(open, buckets);
  const rows = totals ? totalsRows(totals) : [];
  if (!rows.length && !totals?.cost && !totals?.subagents && !buckets.length) return null;
  return (
    <details
      className="chat-token-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{copy.usage}</summary>
      {rows.length > 0 && (
        <table className="chat-token-totals" aria-label={copy.totals}>
          {totals.source === "codex-process" && <caption>{copy.processTotals}</caption>}
          <tbody>
            {rows.map(({ label, value, prefix, sub }) => (
              <tr key={label} className={sub ? "sub" : undefined}>
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
      <Limits buckets={buckets} />
    </details>
  );
}
