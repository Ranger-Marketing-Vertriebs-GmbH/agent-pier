/** English product copy, addressed through the same semantic keys as the German catalog. */
export const repositories = Object.freeze({
  githubAuthenticationFailed: "GitHub sign-in failed. Please update the token.",
  githubAccessDenied:
    "GitHub denied access. Please check token permissions, organization approval or API rate limit.",
  githubRateLimited: "GitHub API rate limit reached. Please try again later.",
  githubListFailed: "Repositories could not be loaded from GitHub.",
  githubResponseTooLarge: "The GitHub response is too large.",
  invalidGithubRepositoryList: "GitHub returned an invalid repository list.",
  searchCancelled: "Repository search was cancelled or timed out. Please try again.",
  githubConnectionFailed:
    "GitHub could not be reached securely. Please check the host, network and HTTPS connection.",
  validHttpsHostRequired: "Please enter a valid HTTPS host without a path.",
  httpsHostRequired: "Please enter an HTTPS host without a path.",
  invalidHttpsHost: "Invalid HTTPS host.",
  invalidAccessToken: "Invalid access token.",
  accessTokenRequired: "Please enter an access token.",
  repositoryAddressRequired: "Please enter an HTTPS repository URL or owner/repo.",
  invalidRepositoryUrl: "Invalid repository URL.",
  repositoryHostMismatch:
    "The repository URL must belong to the HTTPS host of the selected profile and must not contain credentials.",
  gitUnavailable: "Git could not be started. Please check the Git installation.",
  cloneTimeout: "Cloning timed out. Please check the network and repository.",
  cloneFailed:
    "Cloning failed. Please check the repository URL, token permissions and network.",
  cloneAuthenticationFailed:
    "Sign-in failed. Please check the token and repository permissions.",
  cloneCertificateFailed:
    "The HTTPS connection could not be verified. Please check certificates and network.",
  cloneRedirectUnsupported:
    "The server redirects the request. Please use the final HTTPS repository URL.",
  profileNotFound: "GitHub profile not found.",
  invalidDefaultAgent: "Invalid default agent selection.",
  invalidSearchText: "Please enter search text with at most 200 characters.",
  invalidOrganization: "Invalid organization.",
  invalidPage: "Invalid results page.",
  profileTokenMissing:
    "The access token for this profile is missing. Please update the profile.",
  cloneServiceStopping:
    "The server is stopping. New clone operations are no longer possible.",
  newFolderNameRequired: "Please enter a new folder name without a path.",
  targetFolderRequired: "Please enter an existing target folder.",
  targetParentUnavailable:
    "The parent target folder does not exist or is not accessible.",
  targetAlreadyExists: "The target folder already exists. Please choose a new name.",
  targetCreateFailed: "The target folder could not be created.",
  clonedProjectSaveFailed: "The cloned project could not be saved.",
  cloneTargetOrTokenFailed:
    "Cloning failed. Please check the access token and target folder.",
  invalidTemporaryGitConfig: "The temporary Git configuration is invalid.",
  sessionConfigUnavailable: "The GitHub session configuration is not accessible.",
  sessionConfigUpdateFailed: "A GitHub session configuration could not be updated.",
  sessionConfigRemoveFailed: "The GitHub session configuration could not be removed.",
  cloneShutdown: "Cloning was cancelled because the server is shutting down.",
  sessionConfigAlreadyExists: "This GitHub session configuration already exists.",
});
