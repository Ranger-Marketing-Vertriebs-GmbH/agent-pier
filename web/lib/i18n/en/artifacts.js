export const artifactCopy = {
  title: "Artifacts",
  viewer: "Artifact",
  loading: "Loading artifact…",
  unavailable: "This artifact is unavailable.",
  unsupported:
    "This artifact uses unsupported or missing resources. Use bundled HTML, CSS, JavaScript and images without external requests.",
  description: "Private results from your coding sessions.",
  listLoading: "Loading artifacts…",
  empty: "No artifacts yet.",
  retention:
    "Artifacts stay with their session. Pin results to keep them after deleting the session.",
  refresh: "Refresh",
  project: "Project",
  allProjects: "All projects",
  pinned: "Pinned",
  orphaned: "Original session deleted",
  open: "Open",
  pin: "Pin",
  unpin: "Unpin",
  remove: "Delete",
  deleteTitle: "Delete artifact?",
  openLabel: (title) => `Open ${title}`,
  storage: (used, limit) => `${used} of ${limit} used`,
  cleanup: (size) => `${size} awaiting cleanup`,
  deleteBody: (title) =>
    `“${title}” will be permanently deleted, including its saved files.`,
  deleteOrphan: (title) =>
    `The original session no longer exists. Removing the pin deletes “${title}” and its files permanently.`,
  errors: {
    ARTIFACT_RESOURCE_UNSUPPORTED: "Unsupported or missing artifact resources.",
    ARTIFACT_INVALID_SOURCE:
      "Choose an HTML file, image or output folder inside the session workspace. Links and special files cannot be published.",
    ARTIFACT_LIMIT_EXCEEDED:
      "Artifact storage or publication limits have been reached. Delete unused artifacts or make the files smaller.",
    ARTIFACT_STORAGE_FULL: "Not enough storage for this artifact.",
    ARTIFACT_SOURCE_CHANGED:
      "Source files changed during publication. Publish again with a new request ID.",
    ARTIFACT_ACCESS_DENIED: "This session cannot access that artifact.",
    ARTIFACT_SESSION_GONE: "The originating session was deleted or is being deleted.",
    ARTIFACT_NOT_FOUND: "This artifact is unavailable or was deleted.",
    ARTIFACT_INVALID_INPUT: "Check the artifact arguments.",
    ARTIFACT_CONFLICT: "This request ID was already used with different arguments.",
    ARTIFACT_UNAVAILABLE: "Artifact publishing is temporarily unavailable.",
    ARTIFACT_BUSY: "Another artifact is loading. Please try again shortly.",
    ARTIFACT_IO_ERROR: "The artifact could not be read or saved.",
  },
};
