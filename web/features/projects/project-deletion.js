import { projectDeletionCopy as copy } from "../../lib/i18n/messages/project-deletion.js";

// The record error of a failed deletion whose missing folder came back: a new delete
// (the full flow) replaces it, a retry would fail again.
const REAPPEARED = "PROJECT_FOLDER_REAPPEARED";

/**
 * The state a project row shows: its deletion ("deleting", "failed") before its
 * folder ("missing", "unavailable"); null for a present folder.
 */
export function projectState(project) {
  const state = project?.deletion?.state;
  if (state === "deleting" || state === "failed") return state;
  if (project?.folder === "missing" || project?.folder === "unavailable")
    return project.folder;
  return null;
}

/** "Delete project …", or "Remove from AgentPier …" for a folder that is gone. */
export function deleteLabel(project) {
  return project?.folder === "missing" ? copy.removeAction : copy.deleteAction;
}

/** Whether the delete dialog is offered: not while a deletion runs or waits for retry. */
export function canDelete(project) {
  const deletion = project?.deletion;
  return !deletion || (deletion.state === "failed" && deletion.error === REAPPEARED);
}

/** Whether a failed deletion can be continued (POST /project-deletion/retry). */
export function canRetry(project) {
  const deletion = project?.deletion;
  return deletion?.state === "failed" && deletion.error !== REAPPEARED;
}

/**
 * Whether the dialog's confirm button is on: the report is ready and, for a folder
 * on disk, the project's name is typed exactly.
 */
export function confirmReady(report, typed) {
  return Boolean(
    report?.ready && (report.folderState === "missing" || typed === report.name),
  );
}

/** The processes the owner may tick to end them. */
export function endableProcesses(report) {
  return (report?.processes?.list ?? []).filter((item) => item.endable);
}

/**
 * What a deletion loses of unsaved Git work, one line per finding: commits no remote
 * has, uncommitted changes per worktree, linked worktrees outside the folder (kept),
 * and every check that could not run ("could not be checked" warns as well).
 */
export function gitWarnings(report) {
  const lines = [];
  // `named`: the text names the path itself; the others are shown beside it.
  const add = (path, kind, text, named = false) =>
    lines.push({ id: `${path}\n${kind}`, path, text, named });
  for (const { path, report: git } of report?.git ?? []) {
    if (!git || git.status === "none") continue;
    if (git.status !== "ok") {
      add(path, "unchecked", copy.gitUnchecked(path), true);
      continue;
    }
    if (git.unpushedBranches > 0)
      add(path, "unpushed", copy.gitUnpushed(git.unpushedBranches));
    if (git.worktreesChecked === false || git.unpushedBranches === null)
      add(path, "unchecked", copy.gitUnchecked(path), true);
    for (const tree of git.worktrees ?? []) {
      if (tree.checked === false)
        add(tree.path, "tree-unchecked", copy.gitUnchecked(tree.path), true);
      if (tree.changes > 0) add(tree.path, "changes", copy.gitChanges(tree.changes));
      // Commits on a branch count in unpushedBranches; a detached HEAD's do not.
      if (!tree.branch && tree.unpushed > 0 && !(git.unpushedBranches > 0))
        add(tree.path, "tree-unpushed", copy.gitUnpushed(tree.unpushed));
      if (tree.inside === false)
        add(tree.path, "linked", copy.linkedWorktree(tree.path), true);
    }
  }
  return lines;
}

const refusalKeys = {
  root: "root",
  home: "home",
  "home-parent": "homeParent",
  "home-child": "homeChild",
  agentpier: "agentpier",
  "mount-point": "mountPoint",
  symlink: "symlink",
  "not-directory": "notDirectory",
  "drive-unavailable": "driveUnavailable",
  "agentpier-process": "agentpierProcess",
  unreadable: "unreadable",
};

/** Why the preflight refuses the folder (its `refused` code). */
export function refusalText(reason) {
  return copy.refusals[refusalKeys[reason] ?? "unreadable"];
}

/** Why a deletion failed, from the record's error code. */
export function failureText(code) {
  const key = code === "EPERM" ? "EACCES" : code;
  return copy.failures[key] ?? copy.failures.PROJECT_DELETE_FAILED;
}
