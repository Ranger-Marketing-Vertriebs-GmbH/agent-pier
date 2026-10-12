export const extensionsPageCopy = {
  eyebrow: "WORKSPACE / EXTENSIONS",
  subtitle: "Native CLI configuration",
  title: "Extensions",
  description: "MCP servers, skills and plugins for each CLI profile.",
};
export const extensionsHubCopy = {
  profiles: "CLI profiles",
  sharedProfile: "All accounts using this CLI",
  tabs: "Extensions",
  tabMcp: "MCP servers",
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
  headSkill: "Name / description",
  headScope: "Scope",
  headStatus: "Status",
  headSource: "Source",
  headVersion: "Version",
  headType: "Type",
  headPlugin: "Plugin",
  headMarketplace: "Marketplace",
  headAgent: "Agent",
  installedHere: "Installed here",
  readOnly: "Read-only",
  available: "Available",
  builtin: "Built-in",
  customMarketplace: "Custom source",
  pluginCount: (value1) => `${value1} plugins`,
};
export const profileExtensionsCopy = {
  extensionsLoading: "Loading MCP and skills …",
  extensionScopeNote:
    "Codex skills are shared in the user directory and apply to all Codex profiles.",
  confirmSkillRemoval: (value1) =>
    `Remove the skill “${value1}” installed here and its files?`,
  removedNotice: (value1) => `${value1} was removed.`,
  skillsHeading: "Skills",
  extensionSectionPlaceholder: "Name, description or scope",
  noMatchingSkills: "No skills match your search.",
  noSkills: "No skills found in the known profile directories.",
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
  archiveLimitsDescription:
    "One skill per package · up to 10 MiB ZIP, 20 MiB extracted. Existing directories are not overwritten. Installation scripts are not executed.",
  installingSkill: "Installing skill …",
};
export const extensionInputsCopy = {
  fileReadFailed: "The file could not be read.",
};
export const useProfileExtensionsCopy = {
  fileTooLarge: "The skill file must not exceed 10 MiB.",
  unsupportedFileType: "Please choose SKILL.md or a ZIP file.",
};
