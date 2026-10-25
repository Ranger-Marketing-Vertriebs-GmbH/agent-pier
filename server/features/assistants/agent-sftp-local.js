import fs from "node:fs";
import path from "node:path";
import { isUserAgent } from "../users/user-access.js";
import { guardedWorkspaceEntry } from "./team-plugin/tool-guard.js";
import { assistantProblem } from "./assistant-validation.js";

// What of a turn's context decides the local side again when an approved card runs
// after its turn ended (agent-sftp-approvals.js): whose folders, through which task.
const kept = ["assistantId", "requestedBy", "leadRequest", "memberResult"];
export const localContext = (ctx) =>
  Object.fromEntries(kept.filter((k) => ctx[k] !== undefined).map((k) => [k, ctx[k]]));

/**
 * The local side of an agent's SFTP transfer, with the project-folder rules of
 * agent-project-files.js: a granted project folder (`projectId`) in the turn's
 * context (the agent's own levels, a lead's shares, a task member's grant), or
 * without one the agent's own workspace (`<workspaces>/<assistantId>`). An upload
 * only reads, so read access is enough; a download or a sync down writes, so it
 * needs read and write, in a routine the owner's "May write" for project folders,
 * and the proven tool guard of the running Gateway like every agent write. In the
 * workspace a transfer keeps away from what the native tool guard protects there
 * (guardedWorkspaceEntry: prompt files, skills/, .agents/, attachments/,
 * .agentpier/): the predicate travels as the local rules' `guarded` and is asked by
 * name for every entry walked, read or written (an upload of the workspace skips them), and
 * `assertWorkspaceTarget` refuses a local side inside one. AgentPier's data
 * directory holds the workspace, so it is no protected root there; links out of
 * the workspace are still refused. `ctx` is the turn's workspaceContext, or the
 * localContext an approved card stored.
 */
export function agentLocalRoot(w, ctx, { projectId, write = false } = {}) {
  const lockToolConfig = isUserAgent(w.a.store.getAssistant(ctx.assistantId));
  const guard = () => {
    if (!w.a.config?.writeGuard?.())
      throw assistantProblem("projectWriteUnavailable", 503);
  };
  if (projectId === undefined) {
    const workspaces = w.a.attachments?.config?.workspaces;
    if (!workspaces) throw assistantProblem("unavailable", 503);
    // A hook run never writes the agent's workspace (only its memory, natively).
    if (write && ctx.hook) throw assistantProblem("sftpWorkspaceRefused", 403);
    if (write) guard();
    const root = path.join(workspaces, ctx.assistantId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    return {
      root,
      protectedRoots: [],
      guarded: guardedWorkspaceEntry,
      lockToolConfig,
      projectId: null,
      projectName: null,
      workspace: true,
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

/**
 * In the workspace, the local side of a transfer (`local`, a localRoot result) never
 * lies in a guarded entry, and a download or sync down (`write`) never targets the
 * workspace itself: a folder lands in a named, unguarded folder below it, a single
 * file under an unguarded name (also at the top level).
 */
export function assertWorkspaceTarget(spec, local, { write }) {
  if (!spec.workspace) return;
  guardWorkspacePath(path.relative(local.root, local.real).split(path.sep).join("/"), {
    write,
  });
}

/** The same check on the requested path, before it is resolved (and refused as a
 * protected root): a clear answer for a guarded name, existing or not. */
export function assertWorkspacePath(spec, raw, { write }) {
  if (!spec.workspace) return;
  const relative = path.posix
    .normalize(String(raw).replaceAll("\\", "/"))
    .replace(/^\/+/, "");
  if (relative === ".." || relative.startsWith("../")) return;
  guardWorkspacePath(relative === "." ? "" : relative.replace(/\/+$/, ""), { write });
}

function guardWorkspacePath(relative, { write }) {
  if ((relative && guardedWorkspaceEntry(relative.split("/")[0])) || (write && !relative))
    throw assistantProblem("sftpWorkspaceRefused", 403);
}
