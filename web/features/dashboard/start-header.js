// The start page's header and times (tests/unit/start-header.test.js).

/** The greeting by the hour of day: morning until 11, day until 18, else evening. */
export function greetingOf(hour) {
  if (hour >= 5 && hour < 11) return "morning";
  if (hour >= 11 && hour < 18) return "day";
  return "evening";
}

/**
 * The summary's parts, only those that are known and not zero: working sessions
 * (`sessions` null until the state is loaded), working agents (null while agents are
 * off or loading) and the things that need you (null while unknown).
 */
export function summaryParts({ sessions = null, agents = null, attention = null }) {
  const parts = [];
  if (sessions > 0) parts.push({ id: "sessions", count: sessions, tone: "accent" });
  if (agents > 0) parts.push({ id: "agents", count: agents, tone: "plain" });
  if (attention > 0) parts.push({ id: "attention", count: attention, tone: "accent" });
  return parts;
}

/**
 * A short span for "for 3 min" or "2 h ago": `{ unit, value }` in minutes, hours or
 * days, or `{ unit: "now" }` under a minute. Null for an unknown or future time.
 */
export function shortSpan(then, now = Date.now()) {
  if (!Number.isFinite(then) || then <= 0) return null;
  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 0) return null;
  if (minutes < 1) return { unit: "now" };
  if (minutes < 60) return { unit: "minutes", value: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { unit: "hours", value: hours };
  return { unit: "days", value: Math.floor(hours / 24) };
}
