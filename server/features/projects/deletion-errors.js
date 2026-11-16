/**
 * Error codes of a failed project deletion that a retry cannot finish, because the
 * folder on disk is no longer the one the deletion recorded: a missing folder that
 * came back, a folder replaced after the check, or one refused when it was about to
 * be deleted. A new start (fresh preflight, the name typed again) replaces such a
 * record instead (ProjectDeletion); the web app offers Delete, not Retry, for them.
 * No imports: the web app reads this module as well.
 */
export const REPLACEABLE_DELETION_ERRORS = Object.freeze([
  "PROJECT_FOLDER_REAPPEARED",
  "PROJECT_FOLDER_CHANGED",
  "PROJECT_DELETE_REFUSED",
]);

/** Whether a deletion record is a failed one that a new start may replace. */
export const replaceableDeletion = (record) =>
  record?.state === "failed" && REPLACEABLE_DELETION_ERRORS.includes(record.error);

/**
 * The error code of a deletion whose folder and data are gone except the grants of
 * agents that were switched off; it finishes once they run again.
 */
export const AGENTS_OFF = "PROJECT_AGENTS_OFF";

/**
 * Whether a deletion record only waits for the agents to revoke their grants (also
 * while it is being finished: its folder and data are gone, `dataRemoved`). Such a
 * record no longer stands for its folder: it covers no path, blocks no other
 * deletion and is not shown on a project row; only the ids it names stay refused.
 */
export const waitsForAgents = (record) =>
  record?.body?.dataRemoved === true ||
  (record?.state === "failed" && record.error === AGENTS_OFF);
