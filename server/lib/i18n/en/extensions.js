/** English product copy, addressed through the same semantic keys as the German catalog. */
export const extensions = Object.freeze({
  shellManagementUnavailable:
    "MCP and skill management is not available for shell sessions.",
  sharedUserSkillScope: "User · shared by Codex and compatible CLIs",
  codexProfileSkillScope: "Codex profile · existing skills",
  systemReadOnlyScope: "System · read-only",
  claudeProfileScope: "Claude profile",
  claudeUserScope: "Claude user",
  openCodeProfileScope: "OpenCode profile",
  openCodeUserScope: "OpenCode user",
  invalidMcpObject: "The MCP configuration is not a valid object. It was not changed.",
  incompleteSkillMetadata:
    "Metadata is incomplete or not portable. Please check SKILL.md.",
  mcpScopeNotice:
    "Profile-wide MCP configuration. Projects and plugins can add more servers. Changes apply the next time the CLI starts; no server is started here.",
  skillVisibilityNotice: (scope) =>
    `${scope}. Known user and profile folders are shown; project- and plugin-specific skills are not fully covered. Only skills installed here can be removed.`,
  skillSourceRequired: "Please choose a file or URL.",
  invalidSkillUpload: "Please upload a valid file of at most 10 MiB.",
  skillFileTypeRequired: "Please upload SKILL.md or a ZIP file.",
  skillDirectoryAlreadyExists:
    "This skill folder already exists. Existing files were not changed.",
  skillSaveFailed: "The skill could not be saved. Existing skills were not changed.",
  skillNotInstalledHere: "This skill was not installed here.",
  skillDirectoryReplaced:
    "The skill folder was replaced outside AgentPier and remains unchanged.",
  invalidEnvironmentOrHeadersObject:
    "Environment variables and headers must be JSON objects with at most 100 entries.",
  invalidEnvironmentOrHeader: "Invalid environment variable or header.",
  invalidArgumentList: "Arguments must be a JSON list of strings.",
  invalidMcpUrl: "Please enter a valid HTTP or HTTPS MCP URL.",
  targetOutsideProfile: "The target path is outside the profile.",
  linkedPathsReadOnly: "Linked configuration or skill paths are read-only here.",
  cliConfigTooLarge:
    "The CLI configuration is larger than 64 MiB; AgentPier does not read or change it.",
  invalidCliConfigFile: "The CLI configuration is not a regular document.",
  invalidExistingCliConfig:
    "The existing CLI configuration is invalid. It was not changed.",
  cliConfigChanged: "The CLI configuration was changed concurrently. Please reload.",
  cliConfigLayout:
    "This entry cannot be changed precisely in the existing CLI configuration. It was not changed.",
  skillDocumentTooLarge: "SKILL.md can be at most 256 KiB.",
  skillFrontmatterRequired:
    "SKILL.md requires YAML frontmatter with name and description.",
  invalidSkillFrontmatter: "The skill frontmatter is invalid.",
  unsafeZipPath: "The ZIP contains an unsafe file path.",
  skillZipTooLarge: "The ZIP can be at most 10 MiB.",
  skillZipUnreadable: "The ZIP could not be read.",
  skillZipCorrupt: "The ZIP is invalid or corrupted.",
  skillFileCountExceeded: "A skill package can contain at most 1,000 files.",
  specialSkillFilesForbidden:
    "Links and special files are not allowed in skill packages.",
  encryptedSkillZipUnsupported: "Encrypted ZIP files are not supported.",
  extractedSkillTooLarge: "The extracted skill package can be at most 20 MiB.",
  duplicateSkillZipPaths: "The ZIP contains duplicate file paths.",
  skillZipSizeMismatch: "The ZIP exceeds its declared sizes.",
  singleSkillRequired:
    "Please upload exactly one skill with SKILL.md or enter the GitHub link to its folder.",
  skillConfigurationForbidden:
    "Please upload a skill without plugin or MCP configuration.",
  publicSkillSourceRequired: "Please enter a public GitHub folder or ZIP link.",
  skillDownloadHostRestricted:
    "Downloads are only possible via public HTTPS links from github.com or codeload.github.com.",
  invalidGithubLink: "Invalid GitHub link.",
  githubSkillLinkRequired: "Please use a GitHub repository, folder or ZIP link.",
  githubZipLinkRequired: "Please use a valid GitHub ZIP link.",
  invalidGithubRedirect: "GitHub returned an invalid redirect target.",
  skillDownloadFailed: "The public skill package could not be downloaded from GitHub.",
  mcpUrlCredentialsForbidden:
    "The MCP URL must use HTTP or HTTPS and must not contain embedded credentials.",
  invalidSkillIdentity:
    "Skill name: at most 64 lowercase letters, digits and hyphens. A description with at most 1,024 characters is required.",
  skillDownloadTimedOut: "GitHub download failed or timed out.",
  skillDownloadRedirectLimit: "GitHub returned too many redirects.",
  skillRefAmbiguous:
    "This name is both a branch and a tag in the repository. Please use the commit SHA.",
  skillRefNotFound: "The repository has no branch, tag or commit with this name.",
  skillRefRateLimited:
    "GitHub is limiting requests from this machine right now. Please try again later or use the commit SHA.",
  skillRefLookupFailed: "GitHub could not determine the commit of this link.",
  packageSkillUnreadable:
    "The files of this skill could not be read or have changed. Please reload the list.",
  packageSkillNotFound: "This package contains no skill with this name.",
  packageSkillsUnavailable:
    "The package skills are available once the package is installed.",
  skillPreviewRequired: "Please have the skill checked first and confirm the preview.",
  skillPreviewExpired:
    "The preview expired or was already used. Please check the skill again.",
  skillPreviewChanged:
    "The skill no longer matches the preview. Please check the skill again.",
  skillWarningsNotAccepted:
    "The scan found warnings. Please confirm them explicitly before the skill is installed.",
  skillScanBlocked:
    "The scan blocked this skill. It is only installed with an explicit override for the named risks.",
  catalogNameBundled:
    "The agent service already ships a skill with this name. Please rename the skill.",
  catalogNameTaken:
    "A skill with this name is already installed outside the skill catalog. Please rename the skill.",
  catalogSkillNotFound: "This skill is not in the skill catalog.",
  catalogUpdateNeedsRepository:
    "Only skills from a GitHub repository can be checked for updates. Upload a new version to update this skill.",
});
