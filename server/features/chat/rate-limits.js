import { list, object, text, tokens, timestamp } from "./observability-values.js";

const MAX_BUCKETS = 16;
const percent = (value) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : null;

function codexWindow(raw) {
  const value = object(raw);
  const usedPercent = percent(value.used_percent);
  if (usedPercent === null) return null;
  const minutes = tokens(value.window_minutes),
    resets = tokens(value.resets_at);
  return {
    windowMinutes: minutes > 0 ? minutes : null,
    usedPercent,
    resetsAt: resets === null ? null : resets * 1000,
  };
}

function credits(raw, snake) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const balance = raw.balance;
  return {
    hasCredits: (snake ? raw.has_credits : raw.hasCredits) === true,
    unlimited: raw.unlimited === true,
    balance: typeof balance === "string" && balance.length <= 40 ? balance : null,
  };
}

/** One `token_count.rate_limits` snapshot as a bucket; resets_at is epoch seconds. */
export function codexRateLimit(raw) {
  const value = object(raw);
  const limitId = text(value.limit_id, 120);
  if (!limitId) return null;
  return {
    limitId,
    limitName: text(value.limit_name, 120) || null,
    plan: text(value.plan_type, 60) || null,
    windows: [value.primary, value.secondary].map(codexWindow).filter(Boolean),
    credits: credits(value.credits, true),
  };
}

/** Buckets with current windows or usable credits; past windows are hidden. */
export function normalizeLimits(value, now = Date.now()) {
  const buckets = [];
  for (const raw of list(value?.buckets).slice(0, MAX_BUCKETS)) {
    const bucket = object(raw);
    const limitId = text(bucket.limitId, 120);
    const windows = list(bucket.windows).flatMap((entry) => {
      const window = object(entry);
      const usedPercent = percent(window.usedPercent);
      const resetsAt = tokens(window.resetsAt);
      if (usedPercent === null || (resetsAt !== null && resetsAt <= now)) return [];
      const minutes = tokens(window.windowMinutes);
      return [{ windowMinutes: minutes > 0 ? minutes : null, usedPercent, resetsAt }];
    });
    const credit = credits(bucket.credits, false);
    const usable = credit && (credit.hasCredits || credit.unlimited);
    if (!limitId || (!windows.length && !usable)) continue;
    buckets.push({
      limitId,
      limitName: text(bucket.limitName, 120) || null,
      plan: text(bucket.plan, 60) || null,
      windows,
      credits: credit,
    });
  }
  return buckets.length
    ? { source: "codex-rate-limits", buckets, observedAt: timestamp(value?.observedAt) }
    : null;
}
