import { assistantProblem } from "./assistant-validation.js";
import { exact } from "./assistant-access.js";
import { saveWork } from "./assistant-work.js";
import { inheritsFromLead, personalEligible } from "./native-capabilities.js";
import { isUserAgent } from "../users/user-access.js";
import { userAgentLocked } from "../users/user-agent-lock.js";

// A project's Agents section (AGENTPIER-127): the same assistant_access record the
// agent's Work tab edits, seen per project. Coding is the project grant
// (projectIds: memory, coding tasks on the agent's allowed pipelines); a folder level
// needs it, so a level implies the grant and removing the grant removes the level.
export const folderChoices = ["none", "read", "write"];
const view = (policy, projectId) => ({
  coding: policy.projectIds.includes(projectId),
  folder: policy.projectFiles?.[projectId] || "none",
});
const same = (a, b) => a.coding === b.coding && a.folder === b.folder;

function choice(value) {
  exact(value, ["coding", "folder"]);
  if (typeof value.coding !== "boolean" || !folderChoices.includes(value.folder))
    throw assistantProblem("invalid");
  return value;
}

/**
 * The permanent agents (not archived, no task members) with their access to the
 * project, and, read-only, the task members that use it through their lead at the
 * level they have right now.
 */
export function projectAgents(
  { assistants, access, shares = null, memberGrants = null },
  projectId,
) {
  access.s.memory.project(projectId);
  const all = assistants.store.listAssistants();
  const names = new Map(all.map((a) => [a.id, a.name]));
  return {
    agents: all.filter(personalEligible).map((a) => {
      const policy = access.get(a.id);
      return {
        id: a.id,
        name: a.name,
        revision: policy.revision,
        ...view(policy, projectId),
      };
    }),
    // What leads share of this project with their permanent members (lead-shares.js):
    // the owner sees each "via" its lead and can remove it.
    shared: (shares?.list((row) => row.projectId === projectId) || []).map((s) => ({
      id: s.id,
      agentId: s.memberAssistantId,
      name: s.memberName,
      leadId: s.leadId,
      leadName: s.leadName,
      requestId: s.requestId,
      coding: s.live.coding,
      folder: s.live.folder,
    })),
    // What lead agents granted their task members of this project
    // (task-member-grants.js): folders the owner can revoke, coding for information.
    memberGrants: (memberGrants?.list((row) => row.projectId === projectId) || []).map(
      (g) => ({
        id: g.id,
        kind: g.kind,
        revocable: g.revocable,
        agentId: g.memberAssistantId,
        name: g.memberName,
        leadId: g.leadId,
        leadName: g.leadName,
        folder: g.live.folder || "none",
        coding: g.live.coding,
      }),
    ),
    members: all.filter(inheritsFromLead).flatMap((m) => {
      const folder = m.inherited.projects?.[projectId];
      return folder
        ? [
            {
              id: m.id,
              name: m.name,
              leadId: m.parentAssistantId,
              leadName: names.get(m.parentAssistantId) ?? null,
              folder,
            },
          ]
        : [];
    }),
  };
}

/**
 * Sets one agent's access to the project through the Work tab's own save (saveWork:
 * validation, revision, audit, instruction refresh). Only this project's entries
 * change; everything else is taken from the stored record at that moment. `expected`
 * is what the page showed for this project: a change made elsewhere since then is a
 * conflict (409), while unrelated Work tab changes merge. A concurrent save between
 * reading and writing is retried on the newer record.
 */
export function setProjectAgent(services, projectId, id, input) {
  exact(input, ["expected", "coding", "folder"]);
  const expected = choice(input.expected);
  const wanted = choice({ coding: input.coding, folder: input.folder });
  // A folder level needs the project grant: removing the grant removes the level.
  // A user agent has folders only, never the coding grant (user-agent-lock.js).
  const user = isUserAgent(services.access.eligible(id));
  if (user && wanted.coding) throw userAgentLocked();
  const next = wanted.coding || user ? wanted : { coding: false, folder: "none" };
  services.access.s.memory.project(projectId);
  for (let attempt = 0; ; attempt++) {
    const policy = services.access.get(id);
    const current = view(policy, projectId);
    if (!same(current, expected)) throw assistantProblem("conflict", 409);
    const projectIds = policy.projectIds.filter((p) => p !== projectId);
    if (next.coding) projectIds.push(projectId);
    const { [projectId]: _old, ...projectFiles } = policy.projectFiles || {};
    if (next.folder !== "none") projectFiles[projectId] = next.folder;
    try {
      const saved = saveWork(services, id, {
        access: {
          revision: policy.revision,
          projectIds: projectIds.sort(),
          projectFiles,
          pipelineIds: policy.pipelineIds,
          memoryWrite: policy.memoryWrite,
          autonomous: policy.autonomous,
          publish: policy.publish,
        },
      });
      return { id, revision: saved.access.revision, ...view(saved.access, projectId) };
    } catch (error) {
      if (error.status !== 409 || error.key !== "conflict" || attempt >= 2) throw error;
    }
  }
}
