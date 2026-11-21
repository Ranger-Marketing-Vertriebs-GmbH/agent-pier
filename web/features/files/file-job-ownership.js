export const uploadOwnedJob = (job) =>
  ["upload", "upload_group"].includes(job.kind) ||
  (job.kind === "create_directory" && typeof job.uploadGroupId === "string");
export const activeFileJob = (job) =>
  ["queued", "running", "waiting_for_conflict", "cancelling"].includes(job.status);
// An editor save reports in the editor itself (saved, conflict, failed), so it
// stays out of Activity and never leaves a "Needs attention" there.
export const editorOwnedJob = (job) => job.kind === "text_save";
export const activityJob = (job) => !uploadOwnedJob(job) && !editorOwnedJob(job);
