import { assistantProblem } from "./assistant-validation.js";

// Hours between check-ins; "daily" is one check-in at the start of the active hours.
export const heartbeatIntervals = { "1h": 1, "2h": 2, "4h": 4, daily: 24 };
const keys = ["enabled", "interval", "start", "end", "timeZone"];
const defaults = { enabled: false, interval: "4h", start: 9, end: 18, timeZone: "UTC" };

export function validTimeZone(value) {
  if (typeof value !== "string" || !value || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** A stored heartbeat definition; active hours run from `start` to before `end`. */
export function validateHeartbeat(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k)) ||
    typeof input.enabled !== "boolean" ||
    !Object.hasOwn(heartbeatIntervals, input.interval) ||
    !Number.isInteger(input.start) ||
    !Number.isInteger(input.end) ||
    input.start < 0 ||
    input.end > 24 ||
    input.start >= input.end ||
    !validTimeZone(input.timeZone)
  )
    throw assistantProblem("invalid");
  return Object.fromEntries(keys.map((k) => [k, input[k]]));
}

/** The agent's heartbeat with defaults for an agent that never saved one. */
export function heartbeatSettings(assistant) {
  return { ...defaults, ...assistant?.heartbeat };
}

/** The local hours (owner's time zone) at which a check-in runs. */
export function heartbeatHours({ interval, start, end }) {
  const step = heartbeatIntervals[interval];
  const hours = [];
  for (let hour = start; hour < end; hour += step) hours.push(hour);
  return hours;
}

export function heartbeatSchedule(settings) {
  return {
    kind: "cron",
    expr: `0 ${heartbeatHours(settings).join(",")} * * *`,
    tz: settings.timeZone,
  };
}
