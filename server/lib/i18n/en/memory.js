/** English counterpart of de/memory.js with identical keys. */
export const memory = Object.freeze({
  invalidPage: "Invalid memory page.",
  invalidArchiveFilter: "Invalid memory archive filter.",
  invalidSort: "Invalid memory sort order.",
  invalidIdentifier: "Invalid memory identifier.",
  invalidQuery: "Invalid memory query.",
  invalidTitle: "Invalid memory title.",
  invalidContent: "Invalid memory content.",
  invalidInput: "Invalid memory input.",
  unsafeStorage: "Unsafe memory storage.",
  accessUnavailable: "Memory access is unavailable.",
  sessionAccessExists: "Memory session access already exists.",
  invalidProvenance: "Invalid memory provenance.",
  projectChanged: "Memory project changed during registration.",
  projectNotFound: "Memory project not found.",
  invalidRevision: "Invalid memory revision.",
  entryNotFound: "Memory entry not found.",
  expectedRevisionRequired: "An expected revision is required.",
  newEntryRevision: "New memory entries cannot have an expected revision.",
  requestIdUsed: "Memory request identifier was already used.",
  forgottenContent:
    "This title and content were permanently forgotten in this project and cannot be stored again.",
  invalidForgetReason: "Invalid reason for forgetting (500 bytes at most).",
  recordsPending:
    "Agent records still contain the text. AgentPier retries removing it at the next start and the next forget.",
  purgePending:
    "The entry is forgotten, but the memory files are not fully cleaned yet. AgentPier retries at the next start and the next forget.",
  changed: "Memory changed. Reload before saving.",
  archiveStateRequired: "An expected revision and valid archive state are required.",
  invalidProjectDirectory: "Invalid memory project directory.",
  projectDirectoryUnavailable: "Memory project directory is unavailable.",
  gitProjectUnidentified: "Cannot identify the Git memory project.",
  gitDiscoveryTimedOut: "Git project discovery timed out.",
  duplicateChanged: "The older project entry changed. Reload the project and try again.",
  duplicateMergeUnsafe:
    "These entries cannot be merged safely: both hold SSH access, or the older entry already moved elsewhere.",
  projectFolderExcluded:
    "The home folder and collection folders holding several projects are not projects.",
  unsupportedAccount: "Unsupported memory account.",
  reservedMcpName: "Reserved memory MCP name is already configured.",
  discoveryFailed: "Memory discovery hooks could not be configured.",
});
