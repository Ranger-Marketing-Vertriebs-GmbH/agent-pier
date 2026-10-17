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
 * so a refused part leaves the other unchanged. `sshToolChanged` tells the route
 * that the agent gained its first or lost its last SSH grant, `githubChanged` that its
 * GitHub access changed (agent-github.js refresh); `removedProjectIds`
 * names granted projects that no longer exist and were dropped.
 */
export function saveWork({ assistants, access, teams }, id, body) {
  exact(body, ["access", "team"]);
  if (!body.access && !body.team) throw assistantProblem("invalid");
  if (assistants.maintenance) throw assistantProblem("active", 409);
  const accessPart = body.access ? part(body.access) : null;
  const teamPart = body.team ? part(body.team) : null;
  const before = accessPart ? access.get(id) : null;
  const notes = { removedProjectIds: [] };
  const result = teams.transaction(() => {
    const next = accessPart
      ? access.prepare(id, accessPart.input, accessPart.revision, notes)
      : null;
    const team = teamPart
      ? teams.writePolicy(id, teamPart.input, teamPart.revision)
      : teams.policy(id);
    if (next) access.write(id, next);
    return { access: next || access.get(id), team };
  });
  if (before) {
    access.auditSsh(id, before, result.access, "owner");
    access.auditProjects(id, before, result.access);
    access.auditGithub?.(id, before, result.access);
  }
  assistants.changed();
  // Gaining the first or losing the last grant changes the agent's tool list.
  const sshToolChanged =
    !!before && before.sshAccesses.length > 0 !== result.access.sshAccesses.length > 0;
  // A changed GitHub access reaches the agent, its members and the MCP servers.
  const githubChanged =
    !!before && JSON.stringify(before.github) !== JSON.stringify(result.access.github);
  return {
    ...result,
    sshToolChanged,
    githubChanged,
    removedProjectIds: notes.removedProjectIds,
  };
}
