/** English counterpart of de/operations.js with identical keys. */
export const operations = Object.freeze({
  invalidIdentifier: "Invalid operation identifier.",
  directoryLinked: "Operation directory contains a link or non-directory.",
  directoryForeignOwner: "Operation directory is owned by another user.",
  invalidFile: "Invalid operation file or size limit exceeded.",
  jobNotFound: "Operation not found.",
  shuttingDown: "Operations are shutting down.",
  webProcessRestarted:
    "The web process restarted before this operation completed. Review its artifacts before retrying.",
  releaseHelperSilent:
    "The release helper stopped reporting. Inspect service health and the release pointer before retrying.",
  failedUnverified: "The operation failed. No unverified result was accepted.",
  uploadNotFound: "Uploaded archive not found.",
  migrationRunning: "A release migration is running. Wait for it to finish.",
  invalidOptions: "Invalid operation options.",
  invalidDiagnosticScope: "Invalid diagnostic scope.",
  diagnosticProjectNotFound: "Diagnostic project not found.",
  unsafeDatabaseDirectory: "Unsafe database storage directory.",
  unsafeDatabaseFile: "Unsafe database storage file.",
});
