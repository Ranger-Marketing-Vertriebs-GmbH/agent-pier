import { readJSON } from "../../../lib/storage.js";
import { exactCommit, git, gitRef } from "../../pipelines/workspace-git.js";
import { withGitCredentials } from "../../pipelines/workspace-forge.js";
import { assistantProblem } from "../assistant-validation.js";
import { control } from "./session-control.js";

const invalid = () => assistantProblem("invalid");
const running = () => assistantProblem("sessionRunning", 409);

/**
 * Whether the worktree's branch is merged into its base on origin: HEAD is an
 * ancestor of `origin/<baseBranch>` (merge or fast-forward), or `git cherry` finds
 * every commit since the base on it (a rebase merge). A squash merge rewrites the
 * patch, so such a branch counts as unmerged and stays. Fetches `origin` first, best
 * effort, with the host's Git credentials as PipelineWorkspace.prepare does
 * (`manager`: that PipelineWorkspace). Never throws for an unknown base: false.
 */
export async function mergedIntoBase({ cwd, projectRoot, baseBranch, baseSha }, manager) {
  if (manager?.github)
    await withGitCredentials(manager, { projectRoot }, (env) =>
      git(projectRoot, ["fetch", "origin", "--prune"], { env, timeout: 60000 }),
    ).catch(() => {});
  let upstream;
  try {
    upstream = await exactCommit(cwd, `refs/remotes/origin/${gitRef(baseBranch)}`);
  } catch {
    return false;
  }
  const ancestor = await git(cwd, ["merge-base", "--is-ancestor", "HEAD", upstream]).then(
    () => true,
    () => false,
  );
  if (ancestor) return true;
  const limit = /^[a-f0-9]{40,64}$/.test(baseSha ?? "") ? [baseSha] : [];
  const cherry = await git(cwd, ["cherry", upstream, "HEAD", ...limit]).catch(() => null);
  if (cherry === null) return false;
  return !cherry.split("\n").some((line) => line.startsWith("+"));
}

/**
 * stop: stops the agent's session as `POST /sessions/:id/stop` does (through the
 * reload service when there is one). Its worktree and branch stay.
 */
export async function stopSession(w, ctx, input, inv) {
  const { record, session } = await control(w, ctx.assistantId, input.sessionId);
  const sessionId = record.sessionId;
  if (session.status === "running") {
    // The turn may have ended while the session was looked up: never act for it.
    inv?.assertCurrent?.();
    if (w.s.reload) await w.s.reload.stop(sessionId);
    else await w.s.sessions.stop(sessionId);
  }
  const after = await w.s.sessions.get(sessionId);
  const state =
    after.status === "stopped" ? "ended" : (await w.s.activity.read(after)).state;
  w.sessions.store.patch(sessionId, { seen: { state, at: w.sessions.now() } });
  audit(w, {
    action: "session.stopped",
    resourceType: "session",
    ...auditFields(record, session, "stop"),
  });
  return { stopped: true, state };
}

/**
 * worktree_remove: removes the session's worktree once the session is stopped
 * (SESSION_RUNNING), the tree is clean (WORKTREE_DIRTY) and its branch is merged
 * into the base on origin (WORKTREE_NOT_MERGED). The branch always stays
 * (`keptBranch`), so no commit is ever discarded.
 */
export async function removeWorktree(w, ctx, input, inv) {
  const { record, session } = await control(w, ctx.assistantId, input.sessionId);
  const worktree = record.worktree;
  if (!worktree) throw invalid();
  const done = { removed: true, keptBranch: worktree.branch };
  if (worktree.removed) return done;
  if (session.status !== "stopped") throw running();
  const manager = w.s.pipelineWorkspace;
  // The workspace as PipelineWorkspace stored it: its ownership and identity.
  const stored = readJSON(manager.file(worktree.runId), null);
  if (!stored || stored.preparing) throw invalid();
  if (!stored.removed) {
    if ((await manager.inspect(stored)).dirty)
      throw assistantProblem("worktreeDirty", 409);
    if (!(await mergedIntoBase(stored, manager)))
      throw assistantProblem("worktreeNotMerged", 409);
    // The owner may have resumed the session in the meantime.
    if ((await w.s.sessions.get(record.sessionId)).status !== "stopped") throw running();
    inv?.assertCurrent?.();
    await manager.remove({ workspace: stored, confirmLocalCommits: true });
  }
  w.sessions.store.patch(record.sessionId, { worktree: { ...worktree, removed: true } });
  // The schema has no worktree resource: the removal deletes a working copy of the
  // project's repository (its branch stays), so it is a repository deletion.
  audit(w, {
    action: "repository.deleted",
    resourceType: "repository",
    ...auditFields(record, session, "worktree-remove"),
  });
  w.a.changed?.({ feeds: false });
  return done;
}

// Ids and enums only (audit-agent-session-details.js); never paths or branch names.
// The literal action and resourceType stay at the call site (audit-actions-guard).
function auditFields(record, session, op) {
  return {
    source: "system",
    outcome: "success",
    sessionId: record.sessionId,
    projectId: record.projectId,
    details: {
      tool: session.tool,
      agentSession: { assistantId: record.assistantId, op },
    },
  };
}
function audit(w, event) {
  try {
    w.s.audit?.append(event);
  } catch (error) {
    console.error("Agent session audit failed:", error?.message);
  }
}
