export const artifacts = {
  ARTIFACT_UNSUPPORTED_FILE: (name) =>
    `Unsupported file type: "${name}". Publish an output folder containing HTML, CSS, JavaScript, JSON, images and fonts; remove other files such as README.md from that copy.`,
  ARTIFACT_UNSAFE_FILE: (name) =>
    `"${name}" is not a regular file with exactly one link. Symbolic links, hard links and special files are not allowed.`,
  ARTIFACT_INVALID_BUNDLE_PATH: (name) =>
    `Invalid filename or path: "${name}". Use simple ASCII names with letters, digits, spaces, dots, underscores or hyphens; no parent paths (..).`,
  ARTIFACT_DUPLICATE_FILE: (name) =>
    `Duplicate filename: "${name}". Names must be unique even when ignoring letter case.`,
  ARTIFACT_INVALID_ENTRYPOINT: (name) =>
    `Invalid entrypoint: "${name}". For a folder, entrypoint must name an included HTML file; for a single file, the name must match.`,
  ARTIFACT_OUTSIDE_WORKSPACE:
    "The source path is outside the session workspace. Choose an output folder inside that directory.",
  ARTIFACT_STRUCTURE_LIMIT:
    "The output folder has too many entries or is nested too deeply (maximum 1,500 entries and 32 subfolder levels).",

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
};
