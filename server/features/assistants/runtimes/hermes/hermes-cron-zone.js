// Cron expressions in a routine's own IANA time zone on Hermes's cron, which matches
// every expression in the time zone of the agent's process (Hermes v0.22.5
// cron/jobs.py compute_next_run: hermes_time.get_timezone(), else the host's zone; a
// job has no zone of its own). A routine in another zone runs as a pinned job: its
// next occurrence, computed here in its own zone, written as the five-field
// expression `minute hour day month *` of that instant in the process's zone, and
// pinned again to the occurrence after it once it ran (HermesRoutineDeliveries).
// Occurrences follow OpenClaw's schedule policy (docs/assistant-routine-qualification.md):
// a wall-clock time the spring transition skips does not run that day, and a time the
// autumn transition repeats runs at its first occurrence only.

const fieldNames = {
  month: [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ],
  weekday: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
};

// One cron field as its sorted values within [min, max], or null for anything this
// reading does not understand: numbers, names, `*`, ranges, steps and lists.
function field(text, min, max, names) {
  const value = (token) => {
    const named = names?.indexOf(token.toUpperCase());
    if (named !== undefined && named >= 0) return named + (names.length === 12 ? 1 : 0);
    return /^\d{1,2}$/.test(token) ? Number(token) : NaN;
  };
  const values = new Set();
  for (const part of String(text).split(",")) {
    const match = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return null;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    let from = min,
      to = max;
    if (match[1] !== "*") {
      const [a, b] = match[1].split("-").map(value);
      from = a;
      to = b ?? (match[2] === undefined ? a : max);
    }
    if (!(step >= 1) || !(from >= min) || !(to <= max) || !(from <= to)) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((x, y) => x - y);
}

/**
 * A five-field cron expression as its field values, or null: `{ minutes, hours, days,
 * months, weekdays, anyDay, anyWeekday }` (weekday 7 is Sunday). With both day fields
 * restricted, a day matches either (Vixie cron, croniter and OpenClaw alike).
 */
export function parseCron(expression) {
  const parts = String(expression ?? "")
    .trim()
    .split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = field(parts[0], 0, 59);
  const hours = field(parts[1], 0, 23);
  const days = field(parts[2], 1, 31);
  const months = field(parts[3], 1, 12, fieldNames.month);
  const weekdays = field(parts[4], 0, 7, fieldNames.weekday);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((d) => d % 7)),
    anyDay: parts[2] === "*",
    anyWeekday: parts[4] === "*",
  };
}

/** Whether `zone` is an IANA time zone this process knows. */
export function knownZone(zone) {
  if (typeof zone !== "string" || !zone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The time zone of this process, which the agent's Hermes processes share. */
export const processZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const formats = new Map();
function format(zone) {
  if (!formats.has(zone))
    formats.set(
      zone,
      new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      }),
    );
  return formats.get(zone);
}

/** The wall clock of instant `ms` in `zone`: `{ year, month, day, hour, minute }`. */
export function wallOf(ms, zone) {
  const parts = Object.fromEntries(
    format(zone)
      .formatToParts(new Date(ms))
      .map(({ type, value }) => [type, Number(value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

const minuteMs = 60000;
const sameWall = (a, b) =>
  a.year === b.year &&
  a.month === b.month &&
  a.day === b.day &&
  a.hour === b.hour &&
  a.minute === b.minute;

// The instants whose wall clock in `zone` is `wall`, earliest first: none in a gap,
// two in a repeated hour.
function instantsOf(wall, zone) {
  const utc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const found = new Set();
  // Every offset in use lies within a day of UTC; the offsets around this wall time
  // are those of the instants a day either side and of the guess itself.
  for (const probe of [utc - 86400000, utc, utc + 86400000]) {
    const seen = wallOf(probe, zone);
    const offset =
      Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) -
      Math.floor(probe / minuteMs) * minuteMs;
    const candidate = utc - offset;
    if (sameWall(wallOf(candidate, zone), wall)) found.add(candidate);
  }
  return [...found].sort((a, b) => a - b);
}

/**
 * The first occurrence of `expression` in `zone` strictly after `afterMs`, or null
 * when the expression is not understood or names no date within eight years (such
 * as February 30th).
 */
export function nextCronRun(expression, zone, afterMs) {
  const cron = parseCron(expression);
  if (!cron || !knownZone(zone) || !Number.isFinite(afterMs)) return null;
  const start = wallOf(afterMs, zone);
  for (let offset = 0; offset < 366 * 8; offset++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    const day = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
    if (!cron.months.has(day.month)) continue;
    const byDay = cron.days.has(day.day);
    const byWeekday = cron.weekdays.has(date.getUTCDay());
    const matches =
      cron.anyDay && cron.anyWeekday
        ? true
        : cron.anyDay
          ? byWeekday
          : cron.anyWeekday
            ? byDay
            : byDay || byWeekday;
    if (!matches) continue;
    for (const hour of cron.hours)
      for (const minute of cron.minutes) {
        // The first instant of a repeated time only; a skipped time does not run.
        const [first] = instantsOf({ ...day, hour, minute }, zone);
        if (first !== undefined && first > afterMs) return first;
      }
  }
  return null;
}

/** The pinned expression of instant `ms` in `zone`: `minute hour day month *`. */
export function pinnedExpression(ms, zone) {
  const wall = wallOf(ms, zone);
  return `${wall.minute} ${wall.hour} ${wall.day} ${wall.month} *`;
}
