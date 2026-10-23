import fs from "node:fs";
import path from "node:path";
import { isUserAgent } from "../users/user-access.js";
import { assistantProblem } from "./assistant-validation.js";
import { workspaceContext } from "./workspace-calls.js";

/**
 * The local side of an agent's SFTP transfer, with the project-folder rules of
 * agent-project-files.js: a granted project folder (`projectId`) in the turn's
 * context (the agent's own levels, a lead's shares, a task member's grant), or
 * without one the agent's own workspace (`<workspaces>/<assistantId>`). An upload
 * only reads, so read access is enough; a download or a sync down writes, so it
 * needs read and write, in a routine the owner's "May write" for project folders,
 * and the proven tool guard of the running Gateway like every agent write. The
 * workspace is the agent's own, so AgentPier's data directory (which holds it) is
 * not a protected root there; links out of it are still refused.
 */
export function agentLocalRoot(w, inv, { projectId, write = false } = {}) {
  const ctx = workspaceContext(w, inv);
  const lockToolConfig = isUserAgent(w.a.store.getAssistant(ctx.assistantId));
  const guard = () => {
    if (!w.a.config?.writeGuard?.())
      throw assistantProblem("projectWriteUnavailable", 503);
  };
  if (projectId === undefined) {
    const workspaces = w.a.attachments?.config?.workspaces;
    if (!workspaces) throw assistantProblem("unavailable", 503);
    if (write) guard();
    const root = path.join(workspaces, ctx.assistantId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return {
      root,
      protectedRoots: [],
      lockToolConfig,
      projectId: null,
      projectName: null,
    };
  }
  const level = w.folders.levels(ctx)[projectId];
  if (!level) throw assistantProblem("projectFolderNotGranted", 403);
  if (write) {
    if (level !== "write") throw assistantProblem("projectFolderReadOnly", 403);
    if (ctx.routine && !ctx.routine.writable)
      throw assistantProblem("projectRoutineReadOnly", 403);
    guard();
  }
  const project = w.s.memory.project(projectId);
  return {
    root: project.cwd,
    protectedRoots: w.folders.protectedRoots,
    lockToolConfig,
    projectId,
    projectName: project.name ?? null,
  };
}
