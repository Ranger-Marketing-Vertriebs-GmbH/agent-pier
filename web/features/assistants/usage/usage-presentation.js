// How an agent's usage reads (server agent-usage.js): pure, so the Overview group,
// the chat's usage sheet and tests/unit/agent-usage-web.test.js share the rules.
import { assistantUsageCopy as copy } from "../../../lib/i18n/messages/assistant-usage.js";
import { formatNumber } from "../../../lib/i18n/index.js";
import { formatTokens, tokenCount } from "../../chat/token-presentation.js";

/** Whether the figures `usage` (`{ tokens }`) count any token at all. */
export const hasUsage = (usage) => tokenCount(usage?.tokens?.total) > 0;

/**
 * A cost `{ amount, currency }` as money, to the cent, or to a hundredth of a cent
 * below one cent; null for anything else.
 */
export function formatCost(cost) {
  const amount = cost?.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (typeof cost.currency !== "string" || !/^[A-Z]{3}$/.test(cost.currency)) return null;
  const digits = amount > 0 && amount < 0.01 ? 4 : 2;
  return formatNumber(amount, {
    style: "currency",
    currency: cost.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/**
 * What the cost of `usage` shows: the amount, "at least" it when only some model
 * calls have a price, "No price" for usage without any, and nothing without usage.
 * Never a made-up amount: an unknown cost is null on the server and stays unnamed.
 */
export function costText(usage) {
  const amount = formatCost(usage?.cost);
  if (amount === null) return hasUsage(usage) ? copy.noPrice : "";
  return usage.cost.partial ? copy.atLeast(amount) : amount;
}

/** "12.4K tokens · 8K in · 1.2K out · 3.2K from cache", or "No usage". */
export function tokensText(usage) {
  if (!hasUsage(usage)) return copy.none;
  const { tokens } = usage;
  const cached = tokenCount(tokens.cacheRead);
  return [
    copy.tokens(formatTokens(tokens.total)),
    copy.breakdown(formatTokens(tokens.input) ?? "0", formatTokens(tokens.output) ?? "0"),
    cached > 0 ? copy.cached(formatTokens(cached)) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The rows of a chat's token table: `[{ id, value }]`, the unused cache rows left out. */
export function tokenRows(usage) {
  const tokens = usage?.tokens || {};
  return [
    ["input", tokens.input, true],
    ["output", tokens.output, true],
    ["cacheRead", tokens.cacheRead, false],
    ["cacheWrite", tokens.cacheWrite, false],
    ["total", tokens.total, true],
  ]
    .filter(([, value, always]) => tokenCount(value) !== null && (always || value > 0))
    .map(([id, value]) => ({ id, value: formatTokens(value) }));
}

/**
 * The context fill of a chat: "12K of 200K tokens (6 %)", the size alone without a
 * known window, or null without a known size.
 */
export function contextText(context) {
  const used = tokenCount(context?.used);
  if (!(used > 0)) return null;
  const limit = tokenCount(context.limit);
  if (!(limit > 0)) return copy.chat.contextUsed(formatTokens(used));
  const percent = formatNumber(Math.min(100, (used / limit) * 100), {
    maximumFractionDigits: 0,
  });
  return copy.chat.contextOf(formatTokens(used), formatTokens(limit), percent);
}

/** The bars of the 30-day chart: `[{ label, value }]`, the day as its short date. */
export function dailyPoints(daily, formatDay) {
  return (Array.isArray(daily) ? daily : [])
    .filter((day) => typeof day?.date === "string" && tokenCount(day.tokens) !== null)
    .map((day) => ({ label: formatDay(day.date), value: day.tokens }));
}
