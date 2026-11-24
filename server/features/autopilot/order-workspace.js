import fs from "node:fs/promises";
import path from "node:path";
import { readJSON } from "../../lib/storage.js";
import { deleteSession } from "../../application/session-deletion.js";
import { exactCommit, git, gitRef } from "../pipelines/workspace-git.js";
import { withGitCredentials } from "../pipelines/workspace-forge.js";
import { terminal } from "../pipelines/graph-navigation.js";
import { listSessions } from "../sessions/session-list.js";
import { scanFolderProcesses } from "../projects/folder-processes.js";
import { inside } from "../projects/deletion-paths.js";
import { orderError } from "./order-error.js";

const commonArgs = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
export async function assertProject(ctx) {
  if (
    (await fs.realpath(ctx.projectRoot)) !== ctx.projectRoot ||
    (await fs.realpath(await git(ctx.projectRoot, commonArgs))) !== ctx.commonDir ||
    (await fs.realpath(await git(ctx.projectRoot, ["rev-parse", "--show-toplevel"]))) !==
      ctx.projectRoot
  )
    throw orderError("ownershipMismatch");
}

export async function orderBaseRef(ctx) {
  const name = gitRef(
    ctx.baseBranch || (await git(ctx.projectRoot, ["branch", "--show-current"])),
  );
  // Only branch refs can be a merge target; tags, HEAD and commit expressions cannot.
  await git(ctx.projectRoot, ["check-ref-format", "--branch", name]);
  for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
    if (await refExists(ctx.projectRoot, ref)) return ref;
  }
  throw orderError("worktreeUnmerged");
}

async function refExists(cwd, ref) {
  try {
    await git(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function statEntry(file) {
  return fs.lstat(file).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function registrations(ctx) {
  const listing = await git(ctx.projectRoot, ["worktree", "list", "--porcelain", "-z"]);
  return listing.split("\0\0").map((record) => record.split("\0"));
}

async function verifyRegistration(ctx, w) {
  const gitdir = await git(w.cwd, ["rev-parse", "--absolute-git-dir"]);
  if (
    path.dirname(gitdir) !== path.join(ctx.commonDir, "worktrees") ||
    (await fs.realpath(gitdir)) !== gitdir ||
    (await fs.realpath(path.join(w.cwd, ".git"))) !== path.join(w.cwd, ".git")
  )
    throw orderError("ownershipMismatch");
  const registered = await registrations(ctx);
  if (
    !registered.some(
      (row) =>
        row.includes("worktree " + w.cwd) &&
        row.includes("branch refs/heads/" + w.branch),
    )
  )
    throw orderError("ownershipMismatch");
}

export async function orderWorkspace(services, ctx, r) {
  const manager = services.pipelineWorkspace;
  const workspace = r.workspace
    ? await manager.validate(r.workspace)
    : await manager.prepare({
        runId: r.workspaceId,
        cwd: ctx.projectRoot,
        baseBranch: r.baseRef,
      });
  if (
    workspace.runId !== r.workspaceId ||
    workspace.projectRoot !== ctx.projectRoot ||
    workspace.commonDir !== ctx.commonDir ||
    workspace.branch !== `agentpier/${r.workspaceId}` ||
    workspace.baseBranch !== r.baseRef ||
    workspace.cwd !== path.join(ctx.projectRoot, ".agentpier-worktrees", r.workspaceId)
  )
    throw orderError("ownershipMismatch");
  await verifyRegistration(ctx, workspace);
  return workspace;
}

async function assertIdle(s, w, { locked = false } = {}) {
  const sessions = locked ? await listSessions(s.sessions) : await s.sessions.list();
  const active = sessions.filter(
    (session) =>
      session.status === "running" ||
      ["waiting", "reloading"].includes(session.reload?.state) ||
      ["started", "pending"].includes(session.interruption?.resume),
  );
  const runs = s.pipelines.store.all().filter((run) => !terminal(run));
  for (const cwd of [
    ...active.map((s) => s.cwd),
    ...runs.flatMap((run) => [run.cwd, run.workspace?.cwd]),
  ]) {
    if (!cwd) continue;
    if (inside(w.cwd, await fs.realpath(cwd).catch(() => path.resolve(cwd))))
      throw orderError("worktreeBusy");
  }
  const scan = await scanFolderProcesses([w.cwd]);
  if (scan.status !== "ok" || scan.processes.length) throw orderError("worktreeBusy");
}

async function mergedHead(ctx, w, r) {
  const sha = await exactCommit(ctx.projectRoot, "refs/heads/" + w.branch);
  // The cleanup's base and branch are the server's recorded refs. A renamed branch,
  // replaced base, or HEAD that has diverged keeps the order recoverable.
  if (r.cleanHead && r.cleanHead !== sha) throw orderError("worktreeUnmerged");
  const base = await exactCommit(ctx.projectRoot, r.baseRef).catch(() => null);
  if (!base) throw orderError("worktreeUnmerged");
  try {
    await git(ctx.projectRoot, [
      "--no-replace-objects",
      "merge-base",
      "--is-ancestor",
      sha,
      base,
    ]);
  } catch {
    throw orderError("worktreeUnmerged");
  }
  return { sha, base };
}

async function checkClean(ctx, w, r) {
  // Sparse/assume-unchanged entries can hide local edits even from "status".
  const entries = await git(w.cwd, ["ls-files", "-v", "-z"]);
  if (entries.split("\0").some((entry) => /^[Sa-z] /.test(entry)))
    throw orderError("worktreeDirty");
  const dirty = await git(w.cwd, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ]);
  // Even ignored, untracked material disappears with a working copy.
  if (dirty || (await git(w.cwd, ["ls-files", "--others", "-z"])))
    throw orderError("worktreeDirty");
  return mergedHead(ctx, w, r);
}

export async function cleanupOrderResources(s, ctx, { begin }, ownedSession) {
  await assertProject(ctx);
  let r = ctx.resources || {};
  const save = async (patch) => {
    r = { ...r, ...patch };
    await ctx.saveResources(r);
    ctx.resources = r;
  };
  const manager = s.pipelineWorkspace;
  if (!r.workspace) {
    // Recover a prepared workspace whose register update was interrupted. Refuse
    // incomplete preparation: never delete an ambiguous worktree or directory.
    const stored = r.workspaceId && readJSON(manager.file(r.workspaceId), null);
    if (stored) {
      if (stored.preparing) throw orderError("ownershipMismatch");
      await save({
        workspace: await orderWorkspace(s, ctx, { ...r, workspace: stored }),
      });
    } else {
      if (r.sessionId) throw orderError("ownershipMismatch");
      await begin();
      return;
    }
  }
  const w = r.workspace;
  const project = await fs.stat(ctx.projectRoot);
  if (
    project.dev !== w.projectDevice ||
    project.ino !== w.projectInode ||
    w.projectRoot !== ctx.projectRoot ||
    w.commonDir !== ctx.commonDir ||
    w.runId !== r.workspaceId ||
    w.baseBranch !== r.baseRef ||
    w.branch !== `agentpier/${r.workspaceId}` ||
    w.cwd !== path.join(ctx.projectRoot, ".agentpier-worktrees", r.workspaceId)
  )
    throw orderError("ownershipMismatch");
  const exists = !!(await statEntry(w.cwd));
  const ids = [...(r.retiredSessionIds || []), r.sessionId].filter(Boolean);
  for (const id of ids) {
    const session = await ownedSession(id);
    if (
      session &&
      (session.status !== "stopped" ||
        ["waiting", "reloading"].includes(session.reload?.state))
    )
      throw orderError("worktreeBusy");
  }
  const ref = "refs/heads/" + w.branch;
  if (
    r.baseRef.startsWith("refs/remotes/origin/") &&
    (exists || (await refExists(ctx.projectRoot, ref)))
  ) {
    const source = "refs/heads/" + r.baseRef.slice("refs/remotes/origin/".length);
    const refresh = (env) =>
      git(
        ctx.projectRoot,
        [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          "origin",
          "+" + source + ":" + r.baseRef,
        ],
        { env, timeout: 60000 },
      );
    if (manager.github) await withGitCredentials(manager, w, refresh);
    else await refresh();
  }
  let head;
  if (exists) {
    await orderWorkspace(s, ctx, r);
    await assertIdle(s, w);
    head = (await checkClean(ctx, w, r)).sha;
  } else if (!ctx.cleanup || !r.cleanHead) throw orderError("ownershipMismatch");
  if (!ctx.cleanup) await begin();
  if (exists) {
    await save({ cleanHead: head });
    // The normal session creation/reload barrier closes the check/remove race.
    // Starts that acquired it earlier are visible, later starts see no directory.
    await s.sessions.serial(async () => {
      await orderWorkspace(s, ctx, r);
      await assertIdle(s, w, { locked: true });
      await checkClean(ctx, w, r);
      // A non-forced remove checks cleanliness again in Git. Journal the checked
      // SHA first, so interruption here cannot make a moved branch disposable.
      await git(ctx.projectRoot, ["worktree", "remove", w.cwd], { timeout: 60000 });
    });
    await save({ worktreeRemoved: true });
  }
  const listed = await registrations(ctx);
  if (
    listed.some(
      (row) => row.includes("worktree " + w.cwd) || row.includes("branch " + ref),
    )
  )
    throw orderError("ownershipMismatch");
  if (await refExists(ctx.projectRoot, ref)) {
    const { sha, base } = await mergedHead(ctx, w, r);
    // Both identities are checked while Git holds their ref locks.
    await git(ctx.projectRoot, ["update-ref", "--no-deref", "--stdin"], {
      input: `verify ${r.baseRef} ${base}\ndelete ${ref} ${sha}\n`,
    });
  }
  // Order history can link to independent sessions and pipeline runs. Only the IDs
  // reserved by this launcher are eligible, including its retired recovery session.
  for (const id of ids) {
    const session = await ownedSession(id);
    if (!session) continue;
    if (
      session.status !== "stopped" ||
      ["waiting", "reloading"].includes(session.reload?.state)
    )
      throw orderError("worktreeBusy");
    await deleteSession(s, session);
  }
  manager.forget(w.runId);
}
