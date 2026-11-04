// The Changes tab badge reads each shown session's changes summary (the
// `session.changes` topic). Fixtures that do not test it answer "not a repository".
export const noChanges = Object.freeze({
  repository: false,
  startCommit: null,
  workspaces: [],
  changedFiles: 0,
});

/** True for a session's changes summary path (with or without the /api prefix). */
export const isChangesRead = (path) => /\/sessions\/[^/]+\/changes$/.test(path);
