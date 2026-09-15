export const fileTransfersCopy = {
  actions: {
    archive: "Create ZIP",
    download_zip: "Download as ZIP",
    download_folder: "Download this folder as ZIP",
    extract_here: "Extract here",
    extract_to: "Extract to folder …",
  },
  target: "Destination folder",
  archivePolicy:
    "The server checks the selection before creating the ZIP. Omitted links require review and confirmation of the complete list. Special files are omitted and listed in the entry results.",
  extractPolicy:
    "Extract regular files and folders from this ZIP. Existing entries require a decision. Unsupported names, links, encrypted entries and configured limits can stop extraction.",
  sameAttempt:
    "Confirm again to check this same request. Its selection and request identity stay unchanged after a lost response.",
  unknownRequest: "The result of this request is unknown.",
  checkRequest: "Check existing request",
  preparing: "Preparing archive …",
  publicationPolicy:
    "Preparation progress can change. Check the final file results for what finished and what was skipped.",
  retainedResults:
    "Finished results are retained. Unfinished or uncertain entries need review; interruption does not resume them automatically.",
  noneExtracted: "No entries were extracted. Review the skipped or empty results.",
  unknown: "unknown",
  entries: (completed, total) => `${completed} of ${total} entries completed`,
  bytes: (completed, total) => `${completed} of ${total} bytes processed`,
  downloadArchive: "Download archive",
  artifactUnavailable:
    "This archive has no available download. Its retained job results do not guarantee that the artifact still exists.",
  history: "Operation history pages",
  nextJobs: "Next jobs",
  previousJobs: "Previous jobs",
  showResults: "Load entry results",
  nextEntries: "Load next entry page",
  outcomeUnknown: "Completion is unproven",
  omissionsTitle: "Review omitted entries",
  omissionsPolicy:
    "These links and special files will not be included. Consent applies only to this complete, checked archive selection; a changed selection requires another review.",
  loadingOmissions: "Loading and checking every omission page …",
  omissionsCount: (count) => `${count} entries will be omitted.`,
  omissionsConsent: "I have reviewed the complete list and accept these omissions.",
  continueOmissions: "Create ZIP with these omissions",
  reloadOmissions: "Reload omission review",
  reviewRetry: "Review retry",
  retryTitle: "Retry unfinished entries",
  retryPolicy:
    "Only the server-checked eligible selection below will be retried as a new request. The original job and its finished results remain unchanged. Unresolved recovery evidence prevents retry.",
  loadingRetry: "Checking source references and retained results …",
  retryCount: (count) => `${count} eligible entries in this complete selection.`,
  confirmRetry: "Confirm new retry",
  retrySource: (path) => `Source: ${path}`,
};
