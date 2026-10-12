/** English counterpart of de/backups.js with identical keys. */
export const backups = Object.freeze({
  archiveExpansionLimit: "Archive expansion limit exceeded.",
  archiveSizeLimit: "Archive size limit exceeded.",
  invalidArchive: "Invalid or oversized AgentPier archive.",
  unsupportedFormat: "Unsupported backup format or schema.",
  invalidMembers: "Invalid archive members.",
  invalidMember: "Duplicate, linked, or invalid archive member.",
  invalidEncoding: "Invalid archive encoding.",
  checksumMismatch: "Archive checksum mismatch.",
  fileDirectoryConflict: "Archive file conflicts with a directory.",
  passphraseLength: "Encrypted backups require a passphrase of 12 to 4096 characters.",
  passphraseTooShort: "Encrypted backups require a passphrase of at least 12 characters.",
  unsupportedEncryption: "Unsupported credential encryption parameters.",
  passphraseRequired: "A backup passphrase is required.",
  invalidEnvelope: "Invalid credential encryption envelope.",
  authenticationFailed: "Backup passphrase or credential authentication failed.",
  notFound: "Backup not found.",
  invalidMemberPath: "Invalid archive member path.",
  importedProjectNotFound: "Imported AgentBus project not found.",
  invalidHistoryPage: "Invalid imported history page.",
  unsupportedSqliteSchema: "Unsupported embedded SQLite schema version.",
  databaseIntegrity: "Backup database integrity check failed.",
  invalidProjectMapping: "Invalid project mapping.",
  unknownMappedProject: "Project mapping references an unknown project.",
  projectMappingsCollide: "Project mappings collide.",
  invalidMemoryReferences: "Restored memory references are invalid.",
  unexpectedComponent: "Unexpected backup component.",
  invalidMcpServerStore: "The backup's MCP server database is invalid.",
  mcpServerStoreUnusable:
    "This host's MCP server database has an unknown layout and cannot be backed up.",
  invalidMcpServerValues:
    "The backup's sealed MCP server values are invalid. Nothing was restored.",
  invalidManifest: "Invalid backup manifest.",
  credentialManifestMismatch: "Credential manifest does not match archive.",
  restoreTargetInvalid: "Restore target must be an absolute fresh directory.",
  restoreTargetLive: "Restore requires a fresh target outside the live data directory.",
  restoreParentInvalid: "Restore parent must be a directory owned by the current user.",
  restoreTargetExists: "Restore target now exists.",
  invalidOptions: "Invalid backup options.",
  invalidOption: "Invalid backup option.",
  uploadType: "Upload an application/octet-stream backup archive.",
  assistantsBusy:
    "Agents are being updated or maintained. Create the backup again afterwards.",
  memberMismatch: "The archive entries do not match its manifest.",
  insufficientSpace: (required, available) =>
    `Not enough free disk space: ${required} required, ${available} available.`,
  profileChanged: (name, tool) =>
    `Profile "${name}" (${tool}): A file changed during the backup. Create the backup again.`,
  profileUnreadable: (name, tool) =>
    `Profile "${name}" (${tool}): A file is not a regular, owned file and cannot be backed up.`,
  profileCredentialLimit: (name, tool, limit) =>
    `Profile "${name}" (${tool}): Configuration and credentials exceed ${limit}.`,
  changed: Object.freeze({
    sessions: "Sessions: A file changed during the backup. Create the backup again.",
    chat: "Chat histories: A file changed during the backup. Create the backup again.",
    agentbus:
      "AgentBus history: A file changed during the backup. Create the backup again.",
    artifacts: "Artifacts: A file changed during the backup. Create the backup again.",
    assistants: "Agent data: A file changed during the backup. Create the backup again.",
    providerCredentials:
      "Provider connection keys: A file changed during the backup. Create the backup again.",
    repositoryCredentials:
      "Repository credentials: A file changed during the backup. Create the backup again.",
    applicationData:
      "Application data: A file changed during the backup. Create the backup again.",
  }),
  unreadable: Object.freeze({
    sessions: "Sessions: A file is not a regular, owned file and cannot be backed up.",
    chat: "Chat histories: A file is not a regular, owned file and cannot be backed up.",
    agentbus:
      "AgentBus history: A file is not a regular, owned file and cannot be backed up.",
    artifacts: "Artifacts: A file is not a regular, owned file and cannot be backed up.",
    assistants:
      "Agent data: A file is not a regular, owned file and cannot be backed up.",
    providerCredentials:
      "Provider connection keys: A file is not a regular, owned file and cannot be backed up.",
    repositoryCredentials:
      "Repository credentials: A file is not a regular, owned file and cannot be backed up.",
    applicationData:
      "Application data: A file is not a regular, owned file and cannot be backed up.",
  }),
  linked: Object.freeze({
    sessions: "Sessions: Contains a symbolic link and cannot be backed up.",
    chat: "Chat histories: Contains a symbolic link and cannot be backed up.",
    agentbus: "AgentBus history: Contains a symbolic link and cannot be backed up.",
    artifacts: "Artifacts: Contains a symbolic link and cannot be backed up.",
    assistants: "Agent data: Contains a symbolic link and cannot be backed up.",
    providerCredentials:
      "Provider connection keys: Contains a symbolic link and cannot be backed up.",
    repositoryCredentials:
      "Repository credentials: Contains a symbolic link and cannot be backed up.",
    applicationData:
      "Application data: Contains a symbolic link and cannot be backed up.",
  }),
});
