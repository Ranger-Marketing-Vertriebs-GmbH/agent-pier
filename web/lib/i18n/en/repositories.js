export const cloneFormCopy = {
  repositoryCloneTitle: "Clone repository",
  cloneDescription:
    "Public GitHub repositories do not require a token. A profile lets you search accessible repositories. The repository gets a new subdirectory.",
  credentialLabel: "Token profile",
  repositoryFieldsOption: "Public on github.com · no token",
  repositoryUrlLabel: "Repository URL or owner/repo",
  repositoryUrlPlaceholder: "organization/project",
  parentDirectoryLabel: "Parent directory",
  folderNameLabel: "New directory name",
  folderNamePlaceholder: "my-project",
};
export const credentialDialogCopy = {
  commitName: "Commit name (optional)",
  commitEmail: "Commit email (optional)",
  commitIdentityHint:
    "Name and email for commits in sessions using this credential. Leave both fields blank to use existing Git settings. Reload existing sessions after changes. No identity is chosen automatically when multiple hosts are configured without a project assignment.",
  commitIdentityInvalid:
    "Enter a valid commit name and email address, or leave both fields blank.",
  repositoryDialogTitle: "Delete token?",
  deleteCredentialPrefix: "The token profile “",
  deleteCredentialSuffix: "” will be deleted. Your local projects will be preserved.",
  multipleProfilesDescription:
    "Multiple profiles per host are supported — for GitHub and GitHub Enterprise.",
  profileNamePlaceholder: "e.g. Personal or Work",
  enterpriseHostDescription:
    "HTTPS host without a repository path; Enterprise hosts may include a port.",
  githubCliPortRestriction: "GitHub CLI supports hosts without a port.",
  repositoryAgentChoiceLabel: "Default for agents on this host",
  firstCredentialDefaultDescription:
    "The first connection on this host is automatically the default.",
  formContentFieldLabel: "Access token",
  savedTokenPlaceholder: "Saved · enter to replace",
  blankTokenPreservesSecret:
    "Token saved. Leave the field empty to keep the existing token.",
  tokenPrivacyDescription: "The token is stored locally and is not displayed afterward.",
};
export const credentialListCopy = {
  tokenSaved: "Token saved",
  tokenMissing: "No token saved",
  repositoryAgentBadge: "Default for agents",
  repositoryDetailsDescription: "GitHub CLI supports hosts without a port.",
  buttonAriaLabel: (value1) => `Delete ${value1}`,
  repositoryEmpty:
    "You can clone public GitHub repositories without a token. Add a token for private repositories and search.",
};
export const repositoriesPageCopy = {
  pageToplineLabel: "WORKSPACE / REPOSITORIES",
  subtle: "Stored locally",
  pageHeadingTitle: "Your repositories",
  pageHeadingDescription: "From repository to next session.",
  repositoriesLoading: "Loading repositories …",
  repositoryCredentialsTitle: "GitHub profiles",
  savedCredentialsSuffix: " saved",
  agentCredentialDescription:
    "New agent sessions receive the default connection for each host. Cloned projects use their selected connection.",
  repositoryProjectsTitle: "Local projects",
  projectCountSuffix: " projects",
  buttonAriaLabel: (value1) => `Start session in ${value1}`,
  launchProjectSession: "Start session ",
  repositoryEmpty:
    "Your cloned repositories will appear here. Then start a CLI session directly in the project.",
};
export const repositoryPickerCopy = {
  organizationLabel: "Organization",
  searchOrganizations: "Search organizations",
  repositoryPickerFiltersOption: "All accessible repositories",
  searchRepositories: "Search repositories",
  repositoryPickerFiltersPlaceholder: "Name or owner/repo",
  repositoryPickerFieldLabel: "Available repositories",
  searchingRepositories: "Searching repositories …",
  chooseRepository: "Choose repository …",
  retrySearch: "Retry search",
  repositoriesLoading: "Loading accessible repositories …",
  repositoryResultsSummary: (value1, value2) =>
    `${value1} repositories found · page ${value2}`,
  noMatchingRepositories: "No matching repositories found. You can enter a URL below.",
  searchLimitDescription:
    "Search covers the first 1,000 accessible repositories. You can clone additional repositories directly using their URL.",
  previousRepositories: "Previous repositories",
  nextRepositories: "More repositories",
};
export const cloneStoreCopy = {
  notice: (value1) => `“${value1}” was cloned. You can now start a session.`,
};
