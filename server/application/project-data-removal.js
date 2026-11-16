import fs from "node:fs";
import path from "node:path";
import { purgeProjects } from "../features/memory/project-deletions.js";
import { inside } from "../features/projects/deletion-paths.js";
import { deleteSession } from "./session-deletion.js";

/**
 * Removes everything AgentPier keeps about a deleted project folder, the mirror of
 * ProjectRebind#adopt with "remove" instead of "move": session records, AgentBus
 * folders, pipeline runs and their workspace records, queue items, verification,
 * risk and queue settings, ticket data, SSH access, secrets, artifacts, remembered
 * approvals, agent grants and creations, Craft rebuild records, cloned-repository
 * entries, group assignments, and last the memory rows. Every step removes what is
 * still there and skips what is gone, so an interrupted walk resumes. Audit history
 * stays. `body` is the deletion record's DeletionBody (ProjectDeletion).
 */
export async function removeProjectData(services, body, folder, actor = null) {
  const workflows = services.assistantWorkflows ?? null;
  for (const id of body.sessionIds) {
    const session = await services.sessions.get(id).catch((error) => {
      if (error?.status === 404) return null;
      throw error;
    });
    if (session) await deleteSession(services, session);
    workflows?.sessions.store.delete(id);
  }
  for (const busId of body.busIds)
    await fs.promises.rm(busFolder(services, busId), { recursive: true, force: true });
  for (const id of body.runIds) {
    services.pipelines?.store.remove(id);
    services.pipelineWorkspace?.forget(id);
  }
  for (const id of body.projectIds) {
    services.pipelineQueue?.removeProject(id);
    services.pipelineDefinitions?.removeProject(id);
    await services.projectRebind.tickets?.removeProject(id);
    await services.sshManagement.removeProject(id);
    services.secrets.removeProject(id, actor);
    await services.artifacts.removeProject(id);
    for (const rule of services.requests.approvals.list(id))
      services.requests.approvals.remove(rule.id);
    if (workflows) removeAgentAccess(workflows, id);
  }
  for (const id of body.rebuildIds)
    if (services.craftRebuilds?.get(id)) await services.craftRebuilds.remove(id);
  services.repositories.removeProjects(folder);
  services.projectGroups.forget(folder);
  purgeProjects(services.memory, body.projectIds);
}

// Grants, unstarted approvals, creations, lead shares and member grants of agents.
function removeAgentAccess(workflows, id) {
  workflows.revokeProject(id, id);
  workflows.projects.store.removeProject(id);
  for (const share of workflows.shares.list((row) => row.projectId === id))
    workflows.shares.remove(share.id);
  for (const grant of memberGrants(workflows, id))
    workflows.memberGrants.revoke(grant.id);
}

const memberGrants = (workflows, id) =>
  workflows.memberGrants.list((row) => row.kind === "project" && row.projectId === id);

const busFolder = (services, busId) =>
  path.join(services.agentbus.root, "projects", busId);

/**
 * The names of the stores that still hold something of the deleted project; `[]`
 * once removeProjectData finished. Asks the stores the way ProjectRebind#remnants
 * does, plus the path-keyed ones. While the agent services are not running but agent
 * data exists, "agentGrants" stays listed: their grants cannot be checked or revoked.
 */
export function projectDataLeft(services, body, folder) {
  const { memory, pipelineQueue, pipelineDefinitions, projectRebind } = services;
  const workflows = services.assistantWorkflows ?? null;
  const owns = (check) => body.projectIds.some(check);
  const left = {
    sessions: body.sessionIds.some((id) =>
      fs.existsSync(path.join(services.sessions.directory, `${id}.json`)),
    ),
    agentbus: body.busIds.some((id) => fs.existsSync(busFolder(services, id))),
    runs: body.runIds.some((id) => runExists(services, id)),
    workspaces: body.runIds.some(
      (id) =>
        services.pipelineWorkspace && fs.existsSync(services.pipelineWorkspace.file(id)),
    ),
    queue: owns((id) => Boolean(pipelineQueue?.ownsProject(id))),
    pipelineSettings: owns((id) => Boolean(pipelineDefinitions?.hasVerification(id))),
    tickets: owns((id) => Boolean(projectRebind.tickets?.ownsProject(id))),
    ssh: owns((id) => services.sshManagement.knowsProject(id)),
    secrets: owns((id) => services.secrets.projectEntries(id).length > 0),
    artifacts: owns((id) => services.artifacts.ownsProject(id)),
    approvals: owns((id) => services.requests.approvals.list(id).length > 0),
    agentGrants: workflows
      ? owns(
          (id) =>
            workflows.holdsProject(id) ||
            workflows.projects.store.hasProject(id) ||
            workflows.shares.list((row) => row.projectId === id).length > 0 ||
            memberGrants(workflows, id).length > 0,
        )
      : agentDataExists(services),
    agentSessions: Boolean(
      workflows && body.sessionIds.some((id) => workflows.sessions.store.get(id)),
    ),
    craftRebuilds: body.rebuildIds.some((id) => services.craftRebuilds?.get(id)),
    repositories: services.repositories
      .listProjects()
      .some((item) => inFolder(folder, item.path)),
    projectGroups: Object.keys(services.projectGroups.get().assignments).some((key) =>
      inFolder(folder, key),
    ),
    memory: owns((id) => memory.hasProject(id) || memory.ownsEntries(id)),
  };
  return Object.keys(left).filter((name) => left[name]);
}

const inFolder = (folder, value) => inside(folder, path.resolve(value));

function runExists(services, id) {
  try {
    services.pipelines?.store.get(id);
    return Boolean(services.pipelines);
  } catch (error) {
    if (error?.status === 404) return false;
    throw error;
  }
}

// The agent services are off or failed to start, yet their database holds records.
function agentDataExists(services) {
  return fs.existsSync(
    path.join(services.config.dataDir, "assistants", "assistants.sqlite"),
  );
}
