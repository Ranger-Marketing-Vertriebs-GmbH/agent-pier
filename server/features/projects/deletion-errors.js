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
