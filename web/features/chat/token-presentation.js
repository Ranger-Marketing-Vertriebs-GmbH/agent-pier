import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";
import { formatNumber } from "../../lib/i18n/index.js";

export const tokenCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;

export const formatTokens = (value) =>
  tokenCount(value) === null
    ? null
    : formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });

export function formatUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return formatNumber(value, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatDuration(ms) {
  if (tokenCount(ms) === null) return null;
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    rest = seconds % 60;
  if (hours) return copy.durationHours(hours, minutes);
  if (minutes) return copy.durationMinutes(minutes, rest);
  return copy.durationSeconds(rest);
}

export function windowLabel(minutes) {
  if (!(tokenCount(minutes) > 0)) return copy.limitWindow;
  if (minutes % 1440 === 0) return copy.windowDays(minutes / 1440);
  if (minutes % 60 === 0) return copy.windowHours(minutes / 60);
  return copy.windowMinutes(minutes);
}

/** "≥" only when an output lower bound makes up at least half of the shown total. */
export function lowerBoundShown(usage) {
  const output = tokenCount(usage?.outputTokens),
    total = tokenCount(usage?.totalTokens);
  return Boolean(
    usage?.outputIsLowerBound && output !== null && total && output * 2 >= total,
  );
}

/** "12.4K tokens · 1m 32s"; null when neither tokens nor a duration are known. */
export function usageSummary(usage) {
  const total = formatTokens(usage?.totalTokens);
  const duration = formatDuration(usage?.durationMs);
  const parts = [];
  if (total !== null)
    parts.push(copy.tokens(`${lowerBoundShown(usage) ? "≥" : ""}${total}`));
  if (duration) parts.push(duration);
  return parts.length ? parts.join(" · ") : null;
}

/** Bar fill; follows the reported remaining percentage (Codex keeps its baseline). */
export const usedPercent = (context) =>
  typeof context?.remainingPercent === "number" &&
  Number.isFinite(context.remainingPercent)
    ? Math.round((100 - context.remainingPercent) * 10) / 10
    : null;

/** The observed agent of a subagent row, by agent id or by its Agent call id. */
export function observedAgent(message, observed = []) {
  const agentId = message?.subagent?.agentId;
  return (
    (observed || []).find(
      (agent) =>
        (agentId && agent.id === agentId) ||
        (agent.toolUseId && agent.toolUseId === message?.id),
    ) || null
  );
}

/**
 * Rows of the totals table. Codex reasoning is part of its output and is shown as
 * an indented sub-row; OpenCode reports it separately, so it is a row of its own.
 */
export function totalsRows(totals) {
  const codex = typeof totals?.source === "string" && totals.source.startsWith("codex-");
  const row = (label, value, prefix = "", sub = false) => ({ label, value, prefix, sub });
  return [
    row(codex ? copy.inputInclCache : copy.input, totals?.inputTokens),
    row(copy.output, totals?.outputTokens, totals?.outputIsLowerBound ? "≥" : ""),
    ...(codex ? [row(copy.reasoningInOutput, totals?.reasoningTokens, "", true)] : []),
    row(copy.cacheRead, totals?.cacheReadTokens),
    row(copy.cacheWrite, totals?.cacheWriteTokens),
    ...(codex ? [] : [row(copy.reasoning, totals?.reasoningTokens)]),
    row(copy.total, totals?.totalTokens, lowerBoundShown(totals) ? "≥" : ""),
  ].filter((entry) => tokenCount(entry.value) !== null);
}

/**
 * Limit buckets as of `now`, by the server rule: windows past their reset are
 * hidden, and a bucket left without windows and usable credits is dropped.
 */
export function currentBuckets(limits, now = Date.now()) {
  return (limits?.buckets || []).flatMap((bucket) => {
    const windows = (bucket.windows || []).filter(
      (window) => !Number.isSafeInteger(window.resetsAt) || window.resetsAt > now,
    );
    const usable = bucket.credits?.hasCredits || bucket.credits?.unlimited;
    return windows.length || usable ? [{ ...bucket, windows }] : [];
  });
}

/** Earliest future reset of the shown windows, or null. */
export function nextReset(buckets, now = Date.now()) {
  const resets = buckets
    .flatMap((bucket) => bucket.windows.map((window) => window.resetsAt))
    .filter((value) => Number.isSafeInteger(value) && value > now);
  return resets.length ? Math.min(...resets) : null;
}
