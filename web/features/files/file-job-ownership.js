export const uploadOwnedJob = (job) =>
  ["upload", "upload_group"].includes(job.kind) ||
  (job.kind === "create_directory" && typeof job.uploadGroupId === "string");
export const activeFileJob = (job) =>
  ["queued", "running", "waiting_for_conflict", "cancelling"].includes(job.status);
