import { assistantProblem, textValue } from "./assistant-validation.js";
import { projectFileLevels } from "./member-grants.js";

/**
 * Folder levels ("read" or "write") of granted projects, sorted by project id; a
 * level for a project outside `projectIds` is dropped, a malformed one refused.
 */
export function folderLevels(value = {}, projectIds = []) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw assistantProblem("invalid");
  const entries = Object.entries(value);
  if (
    entries.length > 100 ||
    entries.some(([, level]) => !projectFileLevels.includes(level))
  )
    throw assistantProblem("invalid");
  return Object.fromEntries(
    entries
      .filter(([id]) => projectIds.includes(id))
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/**
 * A per-project switch (coding sessions, talk): a sorted subset of the granted
 * projects. Absent keeps the stored ones (filtered to the grant); anything else is
 * refused.
 */
export function projectSubset(value, oldIds, projectIds) {
  if (value === undefined) return oldIds.filter((id) => projectIds.includes(id)).sort();
  if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length)
    throw assistantProblem("invalid");
  for (const id of value) textValue(id, 100);
  if (value.some((id) => !projectIds.includes(id))) throw assistantProblem("invalid");
  return [...value].sort();
}
