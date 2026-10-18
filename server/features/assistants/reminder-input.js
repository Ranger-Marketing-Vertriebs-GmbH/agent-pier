import { assistantProblem, textValue } from "./assistant-validation.js";
// One-shot times must carry an explicit offset; a bare local time would be read
// in the server's time zone, which may differ from the user's.
const offsetTimestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
export const exact = (input, keys) => {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    throw assistantProblem("invalid");
};
export function schedule(input, allowPast = false) {
  exact(input, input?.kind === "at" ? ["kind", "at"] : ["kind", "expr", "tz"]);
  if (input.kind === "at") {
    if (typeof input.at !== "string" || !offsetTimestamp.test(input.at))
      throw assistantProblem("reminderTimezoneRequired");
    const at = Date.parse(input.at);
    if (!Number.isFinite(at) || (!allowPast && at <= Date.now()))
      throw assistantProblem("invalid");
    return { kind: "at", at: new Date(at).toISOString() };
  }
  if (input.kind !== "cron") throw assistantProblem("invalid");
  textValue(input.expr, 100);
  textValue(input.tz, 100);
  try {
    new Intl.DateTimeFormat("en", { timeZone: input.tz });
  } catch {
    throw assistantProblem("invalid");
  }
  return { kind: "cron", expr: input.expr, tz: input.tz };
}
/** An update's input: `enabled` and/or `telegram`, with the revision it read. */
export function updateInput(input) {
  exact(input, ["enabled", "telegram", "revision"]);
  if (
    (input.enabled === undefined && input.telegram === undefined) ||
    (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
    (input.telegram !== undefined && typeof input.telegram !== "boolean")
  )
    throw assistantProblem("invalid");
}
