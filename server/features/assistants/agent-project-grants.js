import { approvalRevision } from "./assistant-access.js";
import { assistantProblem } from "./assistant-validation.js";
import { mayCreateProjects } from "./goal-turns.js";

// The grants of a project an agent created itself (agentpier_project). Like
// AssistantAccess#grantSsh they write only their own fields and keep the approval
// revision, so the agent's pending approvals stay valid and no pipeline hash is
// re-approved; never an owner save (saveWork/prepare), which would cancel them.
// Like grantSsh they check their own audience inside the write: only agents that may
// create projects (goal-turns.js mayCreateProjects) and only registered projects.

const withId = (ids, id) => [...new Set([...ids, id])].sort();
const byId = (levels) =>
  Object.fromEntries(Object.entries(levels).sort(([a], [b]) => (a < b ? -1 : 1)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The stored policy of an agent that may create projects; refuses everyone else.
function creatorPolicy(access, id) {
  const agent = access.eligible(id);
  if (!mayCreateProjects(agent, !!access.s.assistantTelegramSenders?.connected(id)))
    throw assistantProblem("projectNotEligible", 403);
  return access.stored(id);
}
function knownProject(access, projectId) {
  if (typeof projectId !== "string" || !access.knownProject(projectId))
    throw assistantProblem("projectFolderNotGranted", 403);
}

// Writes `fields` over the stored policy unless nothing changes; `changed` says
// whether it wrote, so a caller sends no notice or audit record for a no-op.
function writeNarrow(access, id, before, fields) {
  if (Object.entries(fields).every(([key, value]) => same(before[key], value)))
    return { policy: before, changed: false };
  const policy = access.write(id, {
    ...before,
    ...fields,
    revision: before.revision + 1,
    approvalRevision: approvalRevision(before),
  });
  // The grant is written; a failing change notice must not fail the agent's call.
  try {
    access.s.assistants.changed();
  } catch (error) {
    console.error(
      "Agent project grant change notice failed:",
      error?.name ?? "Error",
      error?.message,
    );
  }
  return { policy, changed: true };
}

/**
 * Grants a registered project the agent just created: the project, its folder for
 * writing and, with `coding`, coding sessions. Returns `{ policy, changed }`.
 */
export function grantCreatedProject(access, id, projectId, { coding = false } = {}) {
  const before = creatorPolicy(access, id);
  knownProject(access, projectId);
  return writeNarrow(access, id, before, {
    projectIds: withId(before.projectIds, projectId),
    projectFiles: byId({ ...before.projectFiles, [projectId]: "write" }),
    ...(coding && { sessionProjectIds: withId(before.sessionProjectIds, projectId) }),
  });
}

/**
 * Switches coding sessions for a project the agent created. Switching on needs the
 * project to be registered and still granted (the owner may have removed it);
 * switching off never does and only drops the project from `sessionProjectIds`.
 * Returns `{ policy, changed }`.
 */
export function setCreatedProjectCoding(access, id, projectId, enabled) {
  const before = creatorPolicy(access, id);
  if (enabled) {
    if (!before.projectIds.includes(projectId))
      throw assistantProblem("projectFolderNotGranted", 403);
    knownProject(access, projectId);
  }
  return writeNarrow(access, id, before, {
    sessionProjectIds: enabled
      ? withId(before.sessionProjectIds, projectId)
      : before.sessionProjectIds.filter((p) => p !== projectId),
  });
}
