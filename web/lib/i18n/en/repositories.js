export const cloneFormCopy = {
  cloneDescription:
    "Public GitHub repositories do not require a token. A profile lets you search accessible repositories. The repository gets a new subdirectory.",
  credentialLabel: "Token profile",
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
  columnAccess: "Access",
  columnToken: "Token",
  columnCommitIdentity: "Commit identity",
};
export const githubAccessPageCopy = {
  pageHeadingTitle: "GitHub connections",
  loading: "Loading GitHub connections …",
};
export const repositoriesPageCopy = {
  agentCredentialDescription:
    "New agent sessions receive the default connection for each host. Cloned projects use their selected connection.",
  buttonAriaLabel: (value1) => `Start session in ${value1}`,
  repositoryEmpty:
    "Your cloned repositories will appear here. Then start a CLI session directly in the project.",
};
export const repositoryPickerCopy = {
  organizationLabel: "Organization",
  searchOrganizations: "Search organizations",
  repositoryPickerFiltersOption: "All accessible repositories",
  searchRepositories: "Search repositories",
  repositoryPickerFieldLabel: "Available repositories",
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
export const tokenCheckCopy = {
  check: "Check",
  checking: "Checking …",
  checkAriaLabel: (name) => `Check token of ${name}`,
  notChecked: "Not checked yet",
  states: {
    valid: "Token valid",
    expiring: "Token expires soon",
    expired: "Token expired",
    invalid: "Token rejected",
    error: "Check failed",
  },
  errors: {
    unauthorized: "GitHub rejected the token. Save a new token.",
    tokenMissing: "No token is saved for this profile.",
    forbidden: "GitHub denied access to the user endpoint.",
    rateLimited: "GitHub's rate limit was reached. Try again later.",
    unreachable: "The GitHub host could not be reached.",
    unexpected: "GitHub returned an unexpected answer.",
  },
  login: (login) => `Signed in as ${login}`,
  tokenTypes: {
    classic: "Classic token",
    "fine-grained": "Fine-grained token",
    oauth: "OAuth token",
    app: "GitHub App token",
    unknown: "Token type unknown",
  },
  scopes: (scopes) => `Scopes: ${scopes}`,
  noScopes: "Scopes: none",
  fineGrainedPermissions: "Permissions are set per repository on GitHub.",
  expires: (date) => `Expires ${date}`,
  noExpiry: "No expiry date",
  ssoRequired: (organization) =>
    `Organization ${organization} requires SAML SSO authorization for this token.`,
  ssoAuthorize: "Authorize on GitHub",
  checkedAt: (time) => `Checked ${time}`,
};
export const sessionGithubCopy = {
  label: "GitHub",
  none: "No GitHub profile",
  profile: (name, host) => `${name} (${host})`,
  removed: (host) => `${host}: profile removed`,
  tokenProblem: (host) =>
    `${host}: token needs attention in Settings → Access → GitHub connections`,
  sshRemote:
    "The project remote uses SSH. GitHub tokens apply to HTTPS only; git uses your SSH keys here.",
};
