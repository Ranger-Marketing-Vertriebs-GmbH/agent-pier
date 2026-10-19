// The shortest gap between two runs of a five-field cron expression, in minutes, as
// far as its minute and hour fields decide it (day fields only thin runs out, so the
// result is a safe lower bound). Null for anything this reading does not understand:
// such an expression is refused rather than guessed.

/** The values of one numeric cron field within [min, max], or null. */
export function cronField(field, min, max) {
  const values = new Set();
  for (const part of String(field).split(",")) {
    const match = /^(\*|\d{1,2}(?:-\d{1,2})?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return null;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    let [from, to] = [min, max];
    if (match[1] !== "*") {
      const [a, b] = match[1].split("-").map(Number);
      from = a;
      // "a/n" runs from a to the end of the range.
      to = b ?? (match[2] === undefined ? a : max);
    }
    if (step < 1 || from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((x, y) => x - y);
}

export function minGapMinutes(expr) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = cronField(fields[0], 0, 59),
    hours = cronField(fields[1], 0, 23);
  if (!minutes || !hours) return null;
  const times = hours.flatMap((h) => minutes.map((m) => h * 60 + m));
  // Across midnight to the next day's first run, the safe assumption.
  let gap = 1440 - times.at(-1) + times[0];
  for (let i = 1; i < times.length; i++) gap = Math.min(gap, times[i] - times[i - 1]);
  return gap;
}
