import { assistantProblem } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";

function part(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw assistantProblem("invalid");
  const { revision, ...input } = value;
  if (!Number.isSafeInteger(revision)) throw assistantProblem("invalid");
  return { revision, input };
}

/**
 * Saves an agent's workflow access and team policy as one change: both revisions are
 * preconditions and both rows are written in one transaction of the agent database,
 * so a refused part leaves the other unchanged.
 */
export function saveWork({ assistants, access, teams }, id, body) {
  exact(body, ["access", "team"]);
  if (!body.access && !body.team) throw assistantProblem("invalid");
  if (assistants.maintenance) throw assistantProblem("active", 409);
  const accessPart = body.access ? part(body.access) : null;
  const teamPart = body.team ? part(body.team) : null;
  const before = accessPart ? access.get(id) : null;
  const result = teams.transaction(() => {
    const next = accessPart
      ? access.prepare(id, accessPart.input, accessPart.revision)
      : null;
    const team = teamPart
      ? teams.writePolicy(id, teamPart.input, teamPart.revision)
      : teams.policy(id);
    if (next) access.write(id, next);
    return { access: next || access.get(id), team };
  });
  if (before) access.auditSsh(id, before, result.access, "owner");
  assistants.changed();
  return result;
}
