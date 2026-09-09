export const extensionsPageCopy = {
  eyebrow: "WORKSPACE / EXTENSIONS",
  subtitle: "Native CLI configuration",
  title: "MCP & Skills",
  description: "Shared tools, skills and agents for each CLI.",
};
export const mcpFormCopy = {
  extensionAddSummary: "Add MCP server",
  extensionAddOnSubmit: "MCP configuration saved. It will load when the CLI next starts.",
  commandLabel: "MCP name",
  extensionFieldsPlaceholder: "my-server",
  localTransport: "Local command · stdio",
  remoteTransport: "Remote URL · HTTP",
  extensionWidePlaceholder: "npx, uvx or executable file",
  argumentsJsonLabel: "Arguments as JSON",
  environmentJsonLabel: "Environment variables as JSON",
  mcpUrlLabel: "MCP URL",
  headersJsonLabel: "HTTP headers as JSON",
  secretStorageDescription:
    "Arguments, variables and header values stay hidden after saving. Use the respective CLI for OAuth sign-in.",
  savingMcp: "Saving MCP …",
};
export const profileExtensionsCopy = {
  extensionsLoading: "Loading MCP and skills …",
  extensionScopeNote:
    "Codex skills are shared in the user directory and apply to all Codex profiles.",
  confirmMcpRemoval: (value1) =>
    `Remove the active MCP configuration “${value1}” from this profile?`,
  confirmSkillRemoval: (value1) =>
    `Remove the skill “${value1}” installed here and its files?`,
  removedNotice: (value1) => `${value1} was removed.`,
  mcpHeading: "MCP servers",
  configuredCountSuffix: " configured",
  mcpCommandSummary: (value1, value2) => `${value1} · ${value2} arguments`,
  savedValuesPrefix: "Credentials saved · ",
  variableCountSuffix: "variables, ",
  headerCountSuffix: " headers",
  noMcpServers: "No MCP servers configured in this profile yet.",
  skillsHeading: "Skills",
  skillsFoundSuffix: " found",
  extensionSectionPlaceholder: "Name, description or scope",
  extensionScope: " · Read-only",
  noMatchingSkills: "No skills match your search.",
  noSkills: "No skills found in the known profile directories.",
};
export const skillInstallFormCopy = {
  fileRequired: "Please choose a skill file first.",
  installedNotice: "Skill installed. Restart the CLI if the skill does not appear yet.",
  destinationLabel: "Destination directory",
  uploadSource: "Upload or drop a file",
  githubSource: "Load from a public GitHub link",
  extensionFieldsOnDrop: "Please drop exactly one ZIP file or SKILL.md.",
  extensionFieldsDescription:
    "Drop a ZIP with SKILL.md and supporting files, or a single SKILL.md here.",
  extensionWide: "Public GitHub link",
  archiveLimitsDescription:
    "One skill per package · up to 10 MiB ZIP, 20 MiB extracted. Existing directories are not overwritten. Installation scripts are not executed.",
  installingSkill: "Installing skill …",
};
export const extensionInputsCopy = {
  invalidJson: (value1) => `${value1}: please enter valid JSON.`,
  jsonShapeRequired: (value1, value2) => `${value1}: ${value2} is required.`,
  fileReadFailed: "The file could not be read.",
};
export const useProfileExtensionsCopy = {
  fileTooLarge: "The skill file must not exceed 10 MiB.",
  unsupportedFileType: "Please choose SKILL.md or a ZIP file.",
};
