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
  appGroup: "App",
  mcpSub: "Connect a coding CLI to AgentPier",
  mcpClients: (count) =>
    count === 1 ? "1 connected client" : `${count} connected clients`,
  mcpUnavailable: "Not available",
  remoteRestart: "Restart required",
  remoteSub: "Reach AgentPier from other devices",
  sshSub: "Keys and hosts",
  secretsSub: "Tokens and URLs for agents and coding CLIs",
  githubSub: "Tokens for clones and pull requests",
  usersSub: "Other people who chat with agents",
  centralTitle: "Provider access, MCP servers",
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
