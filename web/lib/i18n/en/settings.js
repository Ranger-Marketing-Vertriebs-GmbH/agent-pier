export const settingsPageCopy = {
  settingsFormFieldLabel: "Default working directory",
  iconButtonAriaLabel: "Choose default directory",
  defaultDirectoryDescription:
    "New sessions start in this directory. Repositories are cloned into its subdirectories by default. An explicitly selected directory takes precedence.",
  settingsSaved: "Settings saved.",
  directoryRequired: "Enter a default working directory.",
  agentsNotApplied: "Agents were not switched. See the agent diagnostic.",
  autoResumeLabel: "Resume interrupted sessions automatically",
  autoResumeDescription:
    "After a restart or a lost terminal server, AgentPier resumes every interrupted session with its own conversation, one after another. Sessions you stopped stay stopped.",
  loadingSettings: "Loading settings …",
  saveSettings: "Save settings",
};

export const settingsHubCopy = {
  backTo: (tab) => `Back to ${tab}`,
  subpageOf: (tab) => `Settings · ${tab}`,
  mcpClients: (count) =>
    count === 1 ? "1 connected client" : `${count} connected clients`,
  mcpUnavailable: "Not available",
  // The "Moved" group of the General tab (for two releases).
  movedGroup: "Moved",
  movedHint:
    "These entries stay here for two releases, so familiar paths still lead somewhere.",
  movedAgents: "Agent service, updates, dreaming, advanced",
  movedAgentsSub: "Now under Agents › Runtime",
  movedConnections: "SSH accesses, secrets, GitHub connections, model access",
  movedConnectionsSub: "Now under Connections",
  movedMcp: "MCP & access (AgentPier for CLIs)",
  movedMcpSub: "Now under CLIs and extensions › AgentPier as MCP",
  storageSub:
    "System status and clean-up: update backups, histories, agents' dependencies",
  storageFree: (size) => `${size} free`,
  diagnosticsOk: "OK",
  diagnosticsFailed: (count) => (count === 1 ? "1 failure" : `${count} failures`),
  diagnosticsWarnings: (count) => (count === 1 ? "1 warning" : `${count} warnings`),
  checkedAt: (when) => `Checked ${when}`,
  lastBackup: (when) => `Last backup ${when}`,
  installedVersion: (version) => `Installed version ${version}`,
  updateAvailable: (version) => `${version} available`,
  upToDate: "Up to date",
  auditSub: "Owner, users, system, MCP",
};
