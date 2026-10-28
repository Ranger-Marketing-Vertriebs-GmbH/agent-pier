import { approvalRevision } from "./assistant-access.js";
import { assistantProblem } from "./assistant-validation.js";

// The grants of a project an agent created itself (agentpier_project). Like
// AssistantAccess#grantSsh they write only their own fields and keep the approval
// revision, so the agent's pending approvals stay valid and no pipeline hash is
// re-approved; never an owner save (saveWork/prepare), which would cancel them.

const withId = (ids, id) => [...new Set([...ids, id])].sort();
const byId = (levels) =>
  Object.fromEntries(Object.entries(levels).sort(([a], [b]) => (a < b ? -1 : 1)));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Writes `fields` over the stored policy, unless nothing changes.
function writeNarrow(access, id, before, fields) {
  if (Object.entries(fields).every(([key, value]) => same(before[key], value)))
    return before;
  const after = access.write(id, {
    ...before,
    ...fields,
    revision: before.revision + 1,
    approvalRevision: approvalRevision(before),
  });
  // The grant is written; a failing change notice must not fail the agent's call.
  try {
    access.s.assistants.changed();
  } catch (error) {
    console.error("Agent project grant change notice failed:", error?.name ?? "Error");
  }
  return after;
}

/**
 * Grants a project the agent just created: the project, its folder for writing and,
 * with `coding`, coding sessions. Returns the written policy.
 */
export function grantCreatedProject(access, id, projectId, { coding = false } = {}) {
  access.eligible(id);
  const before = access.stored(id);
  return writeNarrow(access, id, before, {
    projectIds: withId(before.projectIds, projectId),
    projectFiles: byId({ ...before.projectFiles, [projectId]: "write" }),
    ...(coding && { sessionProjectIds: withId(before.sessionProjectIds, projectId) }),
  });
}

/**
 * Switches coding sessions for a project the agent created. Switching on needs the
 * project grant still to exist (the owner may have removed it); switching off never
 * does and only drops the project from `sessionProjectIds`. Returns the policy.
 */
export function setCreatedProjectCoding(access, id, projectId, enabled) {
  access.eligible(id);
  const before = access.stored(id);
  if (enabled && !before.projectIds.includes(projectId))
    throw assistantProblem("projectFolderNotGranted", 403);
  return writeNarrow(access, id, before, {
    sessionProjectIds: enabled
      ? withId(before.sessionProjectIds, projectId)
      : before.sessionProjectIds.filter((p) => p !== projectId),
  });
}
