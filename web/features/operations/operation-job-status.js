// The end states server/features/operations/jobs.js writes; a job in one never changes.
const TERMINAL = new Set(["succeeded", "failed", "interrupted"]);
export const terminalJob = (job) => TERMINAL.has(job?.status);
