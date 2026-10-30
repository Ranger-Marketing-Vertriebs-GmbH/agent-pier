// Rules for projects that agents create themselves: the name and the problem keys
// behind the PROJECT_* tool codes (the agent's loop guard bounds how many,
// agent-loop-guard.js). Eligibility (`mayCreateProjects`)
// lives in goal-turns.js, which this module must not be imported from.
import { validDirectoryName } from "../../lib/directories.js";
import { assistantProblem } from "./assistant-validation.js";

// Invisible format and bidi characters, line and paragraph separators, and slash
// look-alikes: they could disguise the name in the owner's notice.
const disguising = /[\p{Cf}\p{Zl}\p{Zp}\u2215\u2044\uff0f\u29f8]/u;

/** A project name: a plain folder name without a leading dot, or a 400. */
export function projectName(value) {
  if (!validDirectoryName(value) || value.startsWith(".") || disguising.test(value))
    throw assistantProblem("projectNameInvalid");
  return value;
}
