// A tool installation is read once and then again only while a job runs, the
// installer is busy with another tool or a start is being submitted.
export const toolPollMs = 1500;

export function toolPollDelay({ job, busy = false, submitting = false } = {}) {
  return job?.status === "running" || busy || submitting ? toolPollMs : null;
}
