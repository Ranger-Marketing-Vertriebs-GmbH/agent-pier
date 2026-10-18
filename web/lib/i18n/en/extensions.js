export const extensionsPageCopy = {
  title: "Extensions",
  description: "Skills and plugins for each CLI profile.",
};
export const extensionsHubCopy = {
  profiles: "CLI profiles",
  sharedProfile: "All accounts using this CLI",
  switchProfile: (name) => `Switch CLI profile, current: ${name}`,
  tabs: "Extensions",
  mcpServers: "MCP servers",
  serversForCli: (count, cli) => `${count} for ${cli}`,
  tabSkills: "Skills",
  tabPlugins: "Plugins",
  tabMarketplaces: "Marketplaces",
  tabAgents: "Agents",
  panelSubtitle: (value1) => `Profile ${value1}`,
  rowActions: (value1) => `Actions for ${value1}`,
  viewLabel: "View",
  installedView: (value1) => `Installed · ${value1}`,
  discoverView: (value1) => `Discover · ${value1}`,
  browseCatalog: "Browse catalog",
  headStatus: "Status",
  headSource: "Source",
  headVersion: "Version",
  installedHere: "Installed here",
  readOnly: "Read-only",
  pluginActive: "Active",
  pluginDisabled: "Disabled",
  pluginDetails: "Details",
  pluginDetailsLabel: (name) => `Details for ${name}`,
  backToPlugins: "Back to plugins",
  path: "Path",
  available: "Available",
  builtin: "Built-in",
  customMarketplace: "Custom source",
  pluginCount: (value1) => `${value1} plugins`,
};
export const profileExtensionsCopy = {
  extensionsLoading: "Loading skills …",
  extensionScopeNote:
    "Codex skills are shared in the user directory and apply to all Codex profiles.",
  confirmSkillRemoval: (value1) =>
    `Remove the skill “${value1}” installed here and its files?`,
  removedNotice: (value1) => `${value1} was removed.`,
  skillsHeading: "Skills",
  extensionSectionPlaceholder: "Name, description or scope",
  noMatchingSkills: "No skills match your search.",
  noSkills: "No skills found in the known profile directories.",
  skillVisibilityNotice: (scope) =>
    `${scope}. Known user and profile folders are shown; project- and plugin-specific skills are not fully covered. Only skills installed here can be removed.`,
  packageOrigin: (name, version) =>
    `From MCP package ${name}@${version} · updated and removed with it`,
  githubOrigin: (repository, kind, ref, commit) =>
    kind === "commit"
      ? `GitHub ${repository} · commit ${commit.slice(0, 12)}`
      : `GitHub ${repository} · ${kind === "tag" ? "tag" : "branch"} ${ref} · commit ${commit.slice(0, 12)}`,
  skillScopes: {
    sharedUserSkillScope: "User · shared by Codex and compatible CLIs",
    codexProfileSkillScope: "Codex profile · existing skills",
    systemReadOnlyScope: "System · read-only",
    claudeProfileScope: "Claude profile",
    claudeUserScope: "Claude user",
    openCodeProfileScope: "OpenCode profile",
    openCodeUserScope: "OpenCode user",
  },
};
export const skillInstallFormCopy = {
  fileRequired: "Please choose a skill file first.",
  installedNotice: "Skill installed. Restart the CLI if the skill does not appear yet.",
  destinationLabel: "Destination directory",
  uploadSource: "Upload file",
  githubSource: "GitHub link",
  extensionFieldsOnDrop: "Please drop exactly one ZIP file or SKILL.md.",
  extensionFieldsDescription:
    "Drop a ZIP with SKILL.md and supporting files, or a single SKILL.md here.",
  extensionWide: "Public GitHub link",
  githubRefHint:
    "A folder link may name a branch, a tag or a full commit SHA after /tree/. AgentPier installs and records the commit it points to now.",
  archiveLimitsDescription:
    "One skill per package · up to 10 MiB ZIP, 20 MiB extracted. Existing directories are not overwritten. Installation scripts are not executed. Before installing, AgentPier checks the files offline and shows the result.",
  installingSkill: "Installing skill …",
};
export const extensionInputsCopy = {
  fileReadFailed: "The file could not be read.",
};
export const useProfileExtensionsCopy = {
  fileTooLarge: "The skill file must not exceed 10 MiB.",
  unsupportedFileType: "Please choose SKILL.md or a ZIP file.",
};
