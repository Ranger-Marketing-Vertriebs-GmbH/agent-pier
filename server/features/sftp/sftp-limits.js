// Caps for one SFTP transfer and its job. Transfers are checked on a pre-scan, before
// any approval card, so an agent can never ask the owner to approve more than this.
export const sftpLimits = Object.freeze({
  maxBytes: 2 * 1024 ** 3,
  maxFiles: 10000,
  maxScanEntries: 50000,
  scanMs: 60000,
  jobMs: 7200000,
  listEntries: 1000,
  pathChars: 4096,
  excludes: 50,
  excludeChars: 200,
  planListLimit: 500,
  resultListLimit: 200,
  mtimeToleranceMs: 2000,
  runningJobs: 2,
});
