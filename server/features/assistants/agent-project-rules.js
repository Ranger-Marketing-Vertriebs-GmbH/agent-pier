// Rules for projects that agents create themselves: the name, the daily limit and
// the problem keys behind the PROJECT_* tool codes. Eligibility (`mayCreateProjects`)
// lives in goal-turns.js, which this module must not be imported from.
import { validDirectoryName } from "../../lib/directories.js";
import { assistantProblem } from "./assistant-validation.js";

export const projectCreateCaps = Object.freeze({ perDay: 10, windowMs: 86400000 });

/** A project name: a plain folder name without a leading dot, or a 400. */
export function projectName(value) {
  if (!validDirectoryName(value) || value.startsWith("."))
    throw assistantProblem("projectNameInvalid");
  return value;
}

/** Throws a 429 when `times` within the window already reach the daily cap. */
export function projectCreateLimit(times, now = Date.now()) {
  const recent = times.filter((time) => now - time < projectCreateCaps.windowMs);
  if (recent.length >= projectCreateCaps.perDay)
    throw assistantProblem("projectCreateLimit", 429, projectCreateCaps.perDay);
}
