// Rules for projects that agents create themselves: the name and the problem keys
// behind the PROJECT_* tool codes (the agent's loop guard bounds how many,
// agent-loop-guard.js). Eligibility (`mayCreateProjects`)
// lives in goal-turns.js, which this module must not be imported from.
import { validDirectoryName } from "../../lib/directories.js";
import { assistantProblem } from "./assistant-validation.js";
import { disguisingCharacters, isShortProjectName } from "../projects/project-names.js";

/**
 * A project name: a plain folder name without a leading dot, or a 400. It must be
 * short (project-names.js), never the owner's request pasted in as the folder name.
 */
export function projectName(value) {
  if (
    !validDirectoryName(value) ||
    value.startsWith(".") ||
    disguisingCharacters.test(value)
  )
    throw assistantProblem("projectNameInvalid");
  if (!isShortProjectName(value)) throw assistantProblem("projectNameTooLong");
  return value;
}
