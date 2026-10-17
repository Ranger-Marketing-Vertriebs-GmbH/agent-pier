const title = "Settings";
const groups = {
  workspace: "Workspace",
  access: "Access",
  operations: "Operations",
};
const sections = {
  assistants: "Agents",
  general: "General",
  mcp: "MCP & access",
  remote: "Remote access",
  ssh: "SSH accesses",
  github: "GitHub connections",
  notifications: "App & notifications",
  diagnostics: "Diagnostics",
  backups: "Backups",
  updates: "Updates",
  audit: "Activity log",
};
export const operationsCopy = {
  sections,
  groups,
  title,
  description: "Manage your workspace, app and operations.",
  loading: "Loading data …",
  refresh: "Refresh",
  retry: "Try again",
  back: "Back",
  next: "Next",
  save: "Save",
  cancel: "Cancel",
  remove: "Delete",
  confirm: "Confirm",
  close: "Close",
  unknown: "Unknown",
  details: "Details",
  empty: "No entries available.",
  audit: "Activity log",
  auditHelp:
    "Events contain selected metadata. Native content and credentials are not logged here.",
  action: "Action",
  outcome: "Outcome",
  all: "All",
  sessionId: "Session ID",
  projectId: "Project ID",
  filter: "Filter",
  clear: "Clear filters",
  success: "Successful",
  failure: "Failed",
  sourceUser: "User",
  sourceSystem: "System",
  sourceMcp: "MCP",
  manageMcpAccess: "Review or revoke MCP access",
  diagnostics: "Diagnostics",
  runChecks: "Run checks",
  scope: "Check scope",
  host: "Host",
  project: "Project",
  chooseProject: "Choose project",
  deep: "Full database check",
  deepHelp:
    "Runs a full SQLite database check instead of a quick check. This may take longer and does not make network or model requests.",
  noReport: "No diagnostic report yet.",
  generatedAt: "Checked at",
  remedy: "Suggested fix",
  checkStatuses: {
    ok: "OK",
    warn: "Notice",
    fail: "Failed",
    skip: "Not checked",
  },
  backups: "Backups",
  createBackup: "Prepare backup",
  includeHistory: "Include history",
  withCredentials: "Include encrypted credentials",
  backupPrivacy:
    "Session, chat and AgentBus histories and CLI histories may contain private task content; they are only backed up encrypted, in backups with a passphrase. Agent chats, channels, workspaces and attachments, pipeline history and artifacts (unpinned ones only with history) are always backed up unencrypted. Credentials cover logins, settings, instructions, skills and agents of managed CLI profiles; caches, logs, installed CLIs and runtimes are never backed up. External local CLI profiles, keychains and repository working directories stay out.",
  historyNeedsPassphrase:
    "Without a passphrase, histories are left out of this backup. To back them up encrypted, also choose “Include encrypted credentials” and set a passphrase.",
  passphrase: "Passphrase",
  plan: "Review backup scope",
  create: "Create backup",
  components: "Components",
  omissions: "Not included",
  consistency: "Snapshot boundaries",
  requiresPassphrase: "A passphrase is required to encrypt credentials.",
  assistantCredentialsNote:
    "Agent credentials in this backup can only be restored on this host. Any credential or provider connection change makes them unreadable; agents then need to sign in again.",
  download: "Download",
  deleteBackup: "Delete this backup?",
  inspectArchive: "Inspect and restore backup",
  archive: "Backup file",
  uploadProgress: (percent, done, total) =>
    `Uploading backup file: ${percent}% (${done} of ${total})`,
  inspect: "Inspect archive",
  targetDataDir: "New data directory",
  restore: "Restore to new directory",
  restoreHelp:
    "The target must be new and its parent directory must already exist. The running application and native sessions remain unchanged.",
  restoreTargetRequired: "Enter the new data directory.",
  restoreMappingRequired: (projects) =>
    `Enter a directory for every project: ${projects}`,
  restorePassphraseRequired: "Enter the backup passphrase.",
  projectMapping: "Map project directories",
  restoreConfirmation:
    "The inspected archive will be restored to a new data directory. No native sessions will be started.",
  restored: "Restore complete",
  credentialsRestored: "Credentials restored",
  yes: "Yes",
  no: "No",
  needsLogin: "Sign-in required",
  needsMcpServerValues: (name) => `MCP server ${name} (enter values again)`,
  needsMcpServerAddress: (name) =>
    `MCP server ${name} (enter the token in its address again)`,
  importedSessions: "Imported sessions",
  changedFilesLeftOut: "Files changed during the backup, not restored",
  importedRuns: "Imported runs",
  updates: "Updates",
  currentVersion: "Installed version",
  channelStable: "Stable — Default",
  channelPreview: "Preview — Release candidates",
  channelCustom: "Custom update source",
  channelStableHelp:
    "Only approved stable releases. Switching to Stable does not install an older version.",
  channelPreviewHelp:
    "Preview includes release candidates for testing as well as stable releases. This selection applies to this AgentPier installation. Release candidates can contain unfinished changes. After a release candidate has migrated your data, rolling back to the previous stable version can be impossible, so create a backup under Settings → Operations → Backups first. Switching back to Stable keeps the installed release candidate until a newer stable release arrives.",
  channelManagedHelp:
    "A custom update source is configured. It is managed on the server.",
  channelUnsupportedHelp:
    "Update channels apply only to a versioned installation. This instance runs from a source checkout or on an unsupported platform, so the selection is disabled.",
  channelManagedSource: (source) => `Update source: ${source}`,
  stagedPrereleaseHelp:
    "Pre-releases that are already staged can still be activated after switching to Stable.",
  prerelease: "Pre-release",
  channel: "Update channel",
  saveChannelFirst: "Save the update channel first.",
  channelBusy: "The update channel can change once the running update job has finished.",
  releaseNotes: "What’s new in this version",
  releaseNotesLoading: "Loading release notes …",
  releaseNotesUnavailable:
    "Release notes are currently unavailable. You can still update.",
  releaseNotesOriginal: "View release on GitHub",
  releaseNotesSince: (version) => `What’s new since version ${version}`,
  releaseNotesPublished: (date) => `published ${date}`,
  releaseNotesEmpty: "This version has no release notes.",
  releaseNotesOverflow: (count) => `Only the ${count} most recent versions are shown.`,
  releaseNotesIncomplete: "Some release notes could not be loaded.",
  releaseNotesAll: "View all releases on GitHub",
  cleanupErrors: {
    cleanupInvalid: "Choose valid versions to remove.",
    cleanupBusy: "Another update operation is running. Try again after it finishes.",
    cleanupChanged:
      "The selected versions can no longer be safely removed. Refresh the list.",
    migrateBusy: "Another release operation is running. Try again after it finishes.",
    migrateChanged: "The sessions of this version changed. Refresh the list.",
    migrateFailed: "Some sessions could not be reloaded. The version was kept.",
    migrateBlocked: "Processes still use this version. The version was kept.",
    migrateInterrupted:
      "The web service stopped before the migration finished. The version was kept.",
    migrateCancelled: "The migration was cancelled. The version was kept.",
  },
  cleanupReleases: "Remove old versions",
  cleanupHelp:
    "Remove unused older versions to free disk space. Active versions and versions used by running processes are kept.",
  cleanupAll: "Delete all old versions",
  cleanupOne: "Delete version",
  cleanupConfirm: (versions) =>
    `Permanently delete these versions: ${versions}? They will no longer be available for rollback.`,
  cleanupUnavailable:
    "Safe cleanup is currently unavailable. Refresh the page and try again.",
  cleanupReasons: {
    active: "Active",
    newer: "Prepared or newer version",
    inUse: "Used by a running process",
    busy: "Update in progress",
    unsafe: "Unsupported directory",
  },
  migrateSessions: "Show sessions",
  migrateLoading: "Loading sessions …",
  migrateEmpty: "No AgentPier session holds this version.",
  migrateStart: "Migrate sessions and delete version",
  migrateInterrupt: "Migrate now and delete",
  migrateCancel: "Cancel migration",
  migrateConfirm: (version, count) =>
    `Move ${count} session(s) to the active version and delete version ${version} afterwards? Busy sessions move after finishing their current step; sessions with unknown state wait until the CLI is recognisably idle.`,
  migrateInterruptConfirm: (version, count) =>
    `Restart ${count} session(s) immediately and delete version ${version} afterwards? Running work is interrupted. Saved conversations are preserved.`,
  migrateIneligibleHint:
    "Some sessions cannot be reloaded. Stop them manually to release the version.",
  migrateUnidentifiedHint: (references) =>
    `Processes outside a session use this version: ${references}. Stop them to release the version.`,
  migrateNodeOnly: (count) =>
    `${count} Node process(es) from this version are re-checked after the migration.`,
  migrateStates: {
    ready: "Ready",
    busy: "Busy",
    unknown: "State unknown",
    queued: "Waiting to become idle",
    reloading: "Reloading",
    approval: "Waiting for approval in the terminal",
    failed: "Failed",
    ineligible: "Cannot reload",
    "unsupported-session": "Pipeline, login or shell session",
    "native-session-unverified": "No verified conversation",
  },
  migrateSucceeded: (count) => `Version deleted, ${count} session(s) reloaded.`,
  migrateFailedSessions: "Not reloaded",
  migrateRemaining: "Still used by",
  activateReload: "Move running sessions to the new version afterwards",
  activateReloadHelp:
    "The migration starts after the new version passes its health check. Busy sessions move after finishing their current step; nothing is interrupted. Sessions that cannot be reloaded keep running on the previous version.",
  checkUpdates: "Check for updates",
  stageRelease: "Stage release",
  activateRelease: "Activate staged release",
  releaseHistory: "Previous versions and rollback",
  rollback: "Roll back version",
  upToDate: "The installed version is up to date.",
  integrity: "Checksum",
  integrityHelp:
    "The checksum verifies download integrity. It does not by itself prove the publisher’s identity.",
  platform: "Platform",
  staged: "Staged",
  activateConfirmation:
    "Activate this staged release? The web service will restart; native sessions will be preserved.",
  rollbackConfirmation:
    "Switch back to this approved release? Current user data will not be replaced with old databases.",
  setupRequired: "Automatic activation requires a versioned installation.",
  healthConfirmed: "Activation and health check confirmed",
  rolledBack: "Previous version restored",
  job: "Operation",
  jobStatuses: {
    running: "Running",
    succeeded: "Completed",
    failed: "Failed",
    interrupted: "Interrupted",
  },
  reconnecting:
    "Connection interrupted. Monitoring of the existing operation will continue.",
  jobHelp: "Reloading does not restart the operation.",
  observe: "View operation",
};
export const diagnosticCopy = {
  account: "Account profile",
  project: "Project directory",
  adapterSession: "Adapter session",
  remedies: {
    platform: "Use a supported macOS or Linux host.",
    pty: "Reinstall dependencies for this Node runtime and platform.",
    tool: "Install the tool or correct the service PATH.",
    project: "Restore or map the project checkout on this host.",
    adapterReload: "Reload the session to restart the protocol adapter.",
    adapterRestartFailed:
      "Reload the session to restart the protocol adapter. If it fails again, test the connection and check its address.",
  },
  checks: {
    platform: "Operating system",
    node: "Node.js runtime",
    pty: "Native terminal module",
    tmux: "tmux",
    git: "Git",
    "cli.codex": "Codex CLI",
    "cli.claude": "Claude Code CLI",
    "cli.opencode": "OpenCode CLI",
    listener: "Web instance",
    service: "User service",
    storage: "Data directory and permissions",
    disk: "Free disk space",
    "database.memory/memory.sqlite": "Memory database",
    "database.pipeline-runs/runs.sqlite": "Pipeline database",
    "database.audit/audit.sqlite": "Audit database",
  },
};
export const backupCopy = {
  descriptions: {
    accounts: "Account profiles",
    repositories: "Registered repositories",
    preferences: "Settings",
    "pipeline-definitions": "Pipeline and profile definitions",
    memory: "Project knowledge",
    "pipeline-history": "Pipeline history",
    audit: "Activity log",
    chat: "Chat history (encrypted)",
    terminal: "Terminal captures (encrypted)",
    "agentbus-history": "AgentBus history (encrypted)",
    assistants: "Agents, their chats, channels and workspaces",
    "sealed-agent-browser-profiles":
      "Agent browser profiles with logins and cookies (encrypted, without caches)",
    "Agent browser profiles (only in backups with a passphrase, then encrypted)":
      "Agent browser profiles (only in backups with a passphrase, then encrypted)",
    "Agent browser caches": "Agent browser caches",
    "Agent browser files that were in use": "Agent browser files that were in use",
    "sealed-assistant-credentials":
      "Agent credentials (sealed; restorable only on this host until any credential or provider connection changes)",
    "Assistant runtimes, package caches, update snapshots, TLS and backup keys":
      "Agent runtimes, package caches, update snapshots, TLS and backup keys",
    "Speech connection (Deepgram key and settings)":
      "Speech connection (Deepgram key and settings)",
    "Agent data skipped: unfinished update state":
      "Agent data skipped: unfinished update state",
    "Agent workspaces too large": "Agent workspaces too large",
    "Agent data too large": "Agent data too large",
    "Unreadable agent runtime files": "Unreadable agent runtime files",
    "Assistant data in unsafe storage": "Agent data in unsafe storage",
    "Assistant links and files not owned by AgentPier":
      "Agent links and files not owned by AgentPier",
    "provider-connections": "Provider connections",
    "encrypted-provider-credentials": "Provider connection keys (encrypted)",
    "Managed SSH accesses, private keys and session assignments":
      "Managed SSH accesses, private keys and session assignments",
    "Workspace login credentials and browser sessions":
      "Workspace login credentials and browser sessions",
    "MCP client grants, OAuth credentials and start request capabilities":
      "MCP client grants, OAuth credentials and start request capabilities",
    "Shared native extensions, Agency agent files and their local installation records":
      "Shared native extensions, Agency agent files and their local installation records",
    "encrypted-managed-profiles":
      "Logins, settings, instructions, skills and agents of managed CLI profiles (encrypted)",
    "cli-histories":
      "CLI histories (encrypted): Codex sessions and generated images, Claude Code projects, to-dos and file history, OpenCode sessions",
    "CLI caches, logs, telemetry and files outside the profile allowlists":
      "CLI caches, logs, telemetry and files outside the profile allowlists",
    "AgentPier and CLI histories": "AgentPier and CLI histories",
    "AgentPier and CLI histories are only backed up in backups with a passphrase, and then encrypted":
      "AgentPier and CLI histories (set a passphrase to back them up encrypted)",
    // Older backups named only the CLI histories.
    "CLI conversation histories": "CLI conversation histories",
    "Linked, shared or foreign files in CLI profiles":
      "Linked, shared or foreign files in CLI profiles",
    "encrypted-repository-credentials": "Repository credentials (encrypted)",
    "External local CLI profiles and OS keychains":
      "External local CLI profiles and OS keychains",
    "Repository checkouts, worktrees and uncommitted files":
      "Repository checkouts, worktrees and uncommitted files",
    "Platform-specific installed tool binaries and caches":
      "Platform-specific installed tool binaries and caches",
    "Live native processes, delivery channels, capabilities and subscriptions":
      "Live native processes, delivery channels, capabilities and subscriptions",
    "File trash, file journals and transfer bytes":
      "File trash, file journals and transfer bytes",
    "Global atomicity across independent native writers":
      "Global atomicity across independent native writers",
    // Older backups declared the MCP server store as left out.
    "MCP servers for agents (definitions, values and bindings)":
      "MCP servers for agents (definitions, values and bindings)",
    "mcp-servers":
      "MCP servers for agents and CLIs (definitions and bindings, no values)",
    "encrypted-mcp-server-values":
      "MCP server header and environment values and address tokens (encrypted)",
    "MCP server OAuth logins": "MCP server OAuth logins",
    "MCP server header and environment values and address tokens":
      "MCP server header and environment values and address tokens",
    "Files removed while the backup was written":
      "Files removed while the backup was written",
    "Files that changed while the backup was written":
      "Files that changed while the backup was written (only line-based histories are restored)",
    "CLI histories are only backed up in backups with a passphrase, and then encrypted":
      "CLI histories are only backed up in backups with a passphrase, and then encrypted",
    "Managed native configuration and credentials":
      "Managed native configuration and credentials",
    "coordinated-application-snapshot; independent-native-captures":
      "Application data is captured together. Native captures are independent.",
    "per-component-snapshots; independent-native-captures":
      "Each component and native capture is recorded independently.",
  },
};
export const importedHistoryCopy = {
  title: "Imported AgentBus history",
  readOnly: "History from a backup; messages will not be delivered again.",
  project: "Imported project",
  choose: "Choose project",
  loading: "Loading history …",
  truncated: "The saved history was truncated.",
  read: "Read",
  pending: "Still pending when backed up",
  unknown: "Unknown",
  empty: "No imported messages available.",
};
