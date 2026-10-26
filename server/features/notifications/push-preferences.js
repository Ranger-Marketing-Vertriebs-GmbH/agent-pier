import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

// Per-device notification preferences. The server applies them, because it puts the
// payload together: a device never receives a name or a preview it did not ask for.

/** How much a notification says: the event type, plus names, plus a short preview. */
export const pushLevels = ["type", "label", "preview"];

/**
 * The events a device can choose, with their defaults. `telegram` is not a kind: it
 * covers agent messages that the paired Telegram chat delivers as well.
 */
export const pushEventDefaults = Object.freeze({
  question: true,
  permission: true,
  "session-waiting": true,
  "pipeline-gate": true,
  "agent-approval": true,
  "session-completed": true,
  "session-ended": true,
  "pipeline-completed": false,
  "pipeline-failed": true,
  "agent-checkin": true,
  "agent-routine": true,
  "agent-hook-throttled": true,
  telegram: false,
});
export const pushEvents = Object.keys(pushEventDefaults);

/** Delivery problems and system warnings reach every device; they cannot be chosen. */
export const systemKinds = new Set([
  "telegram-revocation",
  "github-token",
  "disk-space",
  "test",
]);

/** Kinds that wait for the owner; quiet hours hold them unless the device lets them through. */
export const blockingKinds = new Set([
  "question",
  "permission",
  "session-waiting",
  "pipeline-gate",
  "agent-approval",
]);

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function validTimeZone(value) {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function defaultPreferences(timeZone = null) {
  return {
    level: "type",
    events: { ...pushEventDefaults },
    grouping: true,
    quiet: {
      enabled: false,
      from: "22:00",
      to: "07:00",
      blockingThrough: false,
    },
    timeZone: validTimeZone(timeZone) ? timeZone : null,
  };
}

/**
 * Stored preferences in the current shape. A device registered before preferences
 * existed, or one stored by an older version, gets the defaults for everything it
 * lacks; unknown fields are dropped.
 */
export function normalizePreferences(stored) {
  const base = defaultPreferences();
  if (!stored || typeof stored !== "object") return base;
  const events = { ...base.events };
  for (const key of pushEvents)
    if (typeof stored.events?.[key] === "boolean") events[key] = stored.events[key];
  // Before it had its own switch, a hook's throttle notice was a routine result.
  if (
    typeof stored.events?.["agent-routine"] === "boolean" &&
    stored.events["agent-hook-throttled"] === undefined
  )
    events["agent-hook-throttled"] = stored.events["agent-routine"];
  // Before the split, one switch covered every ended run.
  if (typeof stored.events?.["pipeline-ended"] === "boolean") {
    if (stored.events["pipeline-completed"] === undefined)
      events["pipeline-completed"] = stored.events["pipeline-ended"];
    if (stored.events["pipeline-failed"] === undefined)
      events["pipeline-failed"] = stored.events["pipeline-ended"];
  }
  const quiet = stored.quiet || {};
  return {
    level: pushLevels.includes(stored.level) ? stored.level : base.level,
    events,
    grouping: typeof stored.grouping === "boolean" ? stored.grouping : base.grouping,
    quiet: {
      enabled: typeof quiet.enabled === "boolean" ? quiet.enabled : false,
      from: timePattern.test(quiet.from) ? quiet.from : base.quiet.from,
      to: timePattern.test(quiet.to) ? quiet.to : base.quiet.to,
      blockingThrough:
        typeof quiet.blockingThrough === "boolean" ? quiet.blockingThrough : false,
    },
    timeZone: validTimeZone(stored.timeZone) ? stored.timeZone : null,
  };
}

const invalid = () => problem(serverMessages.notifications.invalidPreferences);

/** A change from the settings page: every given field must be valid. */
export function updatePreferences(current, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const next = normalizePreferences(current);
  if (input.level !== undefined) {
    if (!pushLevels.includes(input.level)) throw invalid();
    next.level = input.level;
  }
  if (input.events !== undefined) {
    if (!input.events || typeof input.events !== "object") throw invalid();
    for (const [key, value] of Object.entries(input.events)) {
      if (!pushEvents.includes(key) || typeof value !== "boolean") throw invalid();
      next.events[key] = value;
    }
  }
  if (input.grouping !== undefined) {
    if (typeof input.grouping !== "boolean") throw invalid();
    next.grouping = input.grouping;
  }
  if (input.quiet !== undefined) {
    const quiet = input.quiet;
    if (!quiet || typeof quiet !== "object") throw invalid();
    for (const key of ["enabled", "blockingThrough"])
      if (quiet[key] !== undefined) {
        if (typeof quiet[key] !== "boolean") throw invalid();
        next.quiet[key] = quiet[key];
      }
    for (const key of ["from", "to"])
      if (quiet[key] !== undefined) {
        if (!timePattern.test(quiet[key])) throw invalid();
        next.quiet[key] = quiet[key];
      }
  }
  if (input.timeZone !== undefined) {
    if (input.timeZone !== null && !validTimeZone(input.timeZone)) throw invalid();
    next.timeZone = input.timeZone;
  }
  return next;
}

/** The device-local minute of the day, in its time zone (the host's when unknown). */
export function localMinutes(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(new Date(now));
  const value = (type) => Number(parts.find((part) => part.type === type)?.value);
  return value("hour") * 60 + value("minute");
}

const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/** Whether the device is inside its quiet hours; a range may run past midnight. */
export function inQuietHours(preferences, now) {
  const { quiet, timeZone } = preferences;
  if (!quiet?.enabled) return false;
  const from = minutes(quiet.from),
    to = minutes(quiet.to);
  if (from === to) return false;
  const at = localMinutes(now, timeZone);
  return from < to ? at >= from && at < to : at >= from || at < to;
}

/** Whether a device wants this event now: its own choice, then its quiet hours. */
export function wantsEvent(preferences, event, now) {
  if (systemKinds.has(event.kind)) return true;
  if (!preferences.events[event.kind]) return false;
  if (event.telegram && !preferences.events.telegram) return false;
  if (!inQuietHours(preferences, now)) return true;
  return blockingKinds.has(event.kind) && preferences.quiet.blockingThrough;
}
