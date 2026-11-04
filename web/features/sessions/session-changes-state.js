// The pure parts of a session's Changes tab: which workspace it shows, how a
// workspace and its diff base read, and when its diff must be read again.

/** The workspace the tab shows: the picked one while it is listed, else the first. */
export function shownWorkspace(summary, picked) {
  const workspaces = summary?.workspaces ?? [];
  if (picked !== null && workspaces.some((w) => w.id === picked)) return picked;
  return workspaces[0]?.id ?? null;
}

/**
 * What of a listed workspace changes its diff (base commit, files, lines); the tab
 * reads the diff again when this changes, never on a timer.
 */
export const diffKey = (entry) =>
  entry
    ? JSON.stringify([
        entry.id,
        entry.base?.sha ?? "",
        entry.files,
        entry.added,
        entry.removed,
      ])
    : null;

/** "<id or session directory> · <branch> · +a −r" for the workspace picker. */
export function workspaceLabel(entry, copy) {
  return [
    entry.id || copy.sessionDirectory,
    entry.branch,
    `+${entry.added} −${entry.removed}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

// refs/heads/main and refs/remotes/origin/main read as "main".
const branchName = (ref = "") => ref.replace(/^refs\/(?:heads|remotes\/origin)\//, "");

/** What a workspace's diff is measured against, in words. */
export function baseLine(base, startCommit, copy) {
  if (base?.kind === "merge-base") return copy.baseMergeBase(branchName(base.ref));
  if (base?.kind === "start-commit")
    return startCommit?.source === "first-open" ? copy.baseFirstOpen : copy.baseStart;
  return copy.baseHead;
}

/** The tab badge's count: changed files across the listed workspaces, 0 for none. */
export const changedCount = (summary) =>
  Number.isSafeInteger(summary?.changedFiles) && summary.changedFiles > 0
    ? summary.changedFiles
    : 0;
