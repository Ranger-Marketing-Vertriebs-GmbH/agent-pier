import os from "node:os";
import { projectDir } from "../lib/config.js";
import { serverMessages } from "../lib/i18n/de.js";
import { projectAgents } from "../features/assistants/project-agent-access.js";
import { activeStatuses } from "../features/craft/rebuild-view.js";
import { terminal } from "../features/pipelines/graph-navigation.js";
import { refusedFolder } from "../features/projects/deletion-paths.js";
import {
  classifyProcesses,
  scanFolderProcesses,
} from "../features/projects/folder-processes.js";
import { unsavedGitWork } from "../features/projects/unsaved-git-work.js";
import { readTmuxServer } from "../features/sessions/tmux-server-identity.js";
import { readProcessTable } from "../features/system-status/process-stats.js";
import { sessionPanes } from "../features/system-status/system-status.js";
import { deletionScope, deletionToken } from "./project-deletion-scope.js";

const waiting = ["queued", "starting"];
const refusalKeys = {
  root: "root",
  home: "home",
  "home-parent": "homeParent",
  "home-child": "homeChild",
  agentpier: "agentpier",
  "mount-point": "mountPoint",
  "contains-mount": "containsMount",
  "mounts-unreadable": "mountsUnreadable",
  symlink: "symlink",
  "not-directory": "notDirectory",
  "drive-unavailable": "driveUnavailable",
  "agentpier-process": "agentpierProcess",
  unreadable: "unreadable",
};

/** The explanation of a report's `refused` code. */
export function refusalMessage(code) {
  const refusals = serverMessages.projectDeletion.refusals;
  return refusals[refusalKeys[code]] ?? refusals.unreadable;
}

const notFound = (error) => error?.status === 404;

/**
 * What still runs in the scope and keeps it from being deleted: running sessions
 * (agent coding sessions name their agent), unfinished pipeline runs, queue items
 * waiting to start and running Craft rebuilds. Read fresh on every call.
 */
export async function deletionBlockers(services, scope) {
  const agentSessions = services.assistantWorkflows?.sessions.store ?? null;
  const sessions = [];
  for (const id of scope.sessionIds) {
    const session = await services.sessions.get(id).catch((error) => {
      if (notFound(error)) return null;
      throw error;
    });
    // A pending reload brings a stopped session back.
    const reloading = ["waiting", "reloading"].includes(session?.reload?.state);
    if (session?.status !== "running" && !reloading) continue;
    const agentId = agentSessions?.get(id)?.assistantId;
    sessions.push({
      id,
      name: session.name,
      tool: session.tool,
      ...(agentId ? { agentId } : {}),
    });
  }
  const runs = [];
  for (const id of scope.runIds) {
    let run;
    try {
      run = services.pipelines?.store.get(id);
    } catch (error) {
      if (notFound(error)) continue;
      throw error;
    }
    if (run && !terminal(run))
      runs.push({ id, pipelineName: run.pipelineName, status: run.status });
  }
  const queue = scope.projectIds.flatMap((projectId) =>
    (services.pipelineQueue?.store.list(projectId) ?? [])
      .filter((item) => waiting.includes(item.state))
      .map((item) => ({ id: item.id, projectId, state: item.state })),
  );
  const rebuilds = scope.rebuildIds
    .map((id) => services.craftRebuilds?.get(id))
    .filter((rebuild) => rebuild && activeStatuses.has(rebuild.status))
    .map((rebuild) => ({ id: rebuild.id, name: rebuild.name }));
  return { sessions, runs, queue, rebuilds };
}

/** What the process classification needs to know about AgentPier's own processes. */
async function processContext(services) {
  // All sessions of a data directory share one tmux server (tmux-naming.js).
  const [table, panes, tmux] = await Promise.all([
    readProcessTable(),
    sessionPanes(services.sessions),
    readTmuxServer(services.sessions),
  ]);
  return {
    table,
    sessionPanes: panes,
    tmuxPid: tmux?.pid ?? null,
    gatewayPid: services.systemStatus?.gatewayPid?.() ?? null,
  };
}

export const preflightProbes = {
  refusedFolder,
  scan: (folders) => scanFolderProcesses(folders),
  processContext,
  classify: classifyProcesses,
  git: (folder) => unsavedGitWork(folder),
};

// A scan that does not finish, or fails, blocks; so does a missing process table,
// without which AgentPier's own processes could not be told apart.
async function folderProcesses(services, folder, probes) {
  const result = await probes
    .scan([folder])
    .catch(() => ({ status: "failed", processes: [] }));
  if (result.status !== "ok") return { status: result.status, list: [] };
  if (!result.processes.length) return { status: "ok", list: [] };
  let context;
  try {
    context = await probes.processContext(services);
  } catch {
    return { status: "failed", list: [] };
  }
  return { status: "ok", list: probes.classify(result.processes, context) };
}

// One report per project folder; a nested project that is a worktree already listed
// in an earlier report is not checked twice.
async function gitReports(scope, probes) {
  const reports = await Promise.all(
    scope.projects.map(async (project) => ({
      path: project.path,
      report: await probes.git(project.path).catch(() => ({
        status: "unchecked",
        worktrees: [],
        unpushedBranches: null,
        worktreesChecked: false,
      })),
    })),
  );
  const listed = new Set();
  return reports.filter(({ path, report }) => {
    if (listed.has(path)) return false;
    for (const worktree of report?.worktrees ?? []) listed.add(worktree.path);
    listed.add(path);
    return true;
  });
}

/**
 * Agents with access to any project of the scope (their own grant, a lead's share or
 * a lead's member grant) and the users those agents serve. Informational: a source
 * that cannot be read lists nothing.
 */
function projectAccess(services, scope) {
  const workflows = services.assistantWorkflows ?? null;
  const assistants = services.assistants ?? null;
  if (!workflows || !assistants?.store) return { agents: [], users: [] };
  const found = new Map();
  const add = (id, name, via) => {
    if (id && !found.has(id)) found.set(id, { id, name, via });
  };
  for (const projectId of scope.projectIds) {
    let access;
    try {
      access = projectAgents(
        {
          assistants,
          access: workflows.access,
          shares: workflows.shares,
          memberGrants: workflows.memberGrants,
        },
        projectId,
      );
    } catch {
      continue;
    }
    for (const agent of access.agents)
      if (agent.coding || agent.folder !== "none" || agent.sessions || agent.talk)
        add(agent.id, agent.name, "grant");
    for (const share of access.shared) add(share.agentId, share.name, "share");
    for (const grant of access.memberGrants) add(grant.agentId, grant.name, "member");
    for (const member of access.members) add(member.id, member.name, "member");
  }
  const agents = [...found.values()];
  const profiles = new Map(
    assistants.store.listAssistants().map((profile) => [profile.id, profile]),
  );
  const users = new Map();
  for (const agent of agents)
    for (const { userId } of profiles.get(agent.id)?.userAccess?.members ?? []) {
      if (users.has(userId)) continue;
      try {
        const user = services.users.get(userId);
        users.set(userId, { id: user.id, name: user.displayName || user.username });
      } catch {
        // A user removed since the agent was assigned sees nothing.
      }
    }
  return { agents, users: [...users.values()] };
}

/**
 * The report the delete dialog shows and the delete re-checks: the projects in the
 * folder, what blocks (running work, processes using the folder), what warns
 * (unsaved Git work), who has access, and the token that pins the folder. A refusal
 * (a dangerous path, a missing drive, a process AgentPier needs in the folder) ends
 * the checks of the folder. A missing folder skips the process scan and Git.
 */
export async function preflight(services, rawPath, overrides = {}) {
  const probes = { ...preflightProbes, ...overrides };
  const scope = await deletionScope(services, rawPath);
  const blockers = await deletionBlockers(services, scope);
  const access = projectAccess(services, scope);
  let refused = null,
    processes = { status: "skipped", list: [] },
    git = [];
  if (scope.folderState === "unavailable") refused = "drive-unavailable";
  else if (scope.folderState === "present") {
    try {
      refused = await probes.refusedFolder(scope.path, {
        home: services.config.home ?? os.homedir(),
        dataDir: services.config.dataDir,
        installDir: projectDir,
      });
    } catch {
      refused = "unreadable";
    }
    if (!refused) {
      [processes, git] = await Promise.all([
        folderProcesses(services, scope.path, probes),
        gitReports(scope, probes),
      ]);
      if (processes.list.some((item) => item.protected)) refused = "agentpier-process";
    }
  }
  const blocked = Object.values(blockers).some((list) => list.length > 0);
  return {
    token: deletionToken(scope),
    path: scope.path,
    name: scope.name,
    folderState: scope.folderState,
    refused,
    projects: scope.projects,
    blockers,
    processes,
    git,
    access,
    ready:
      !refused &&
      !blocked &&
      ["ok", "skipped"].includes(processes.status) &&
      processes.list.length === 0,
  };
}
