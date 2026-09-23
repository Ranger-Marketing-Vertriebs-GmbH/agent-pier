/** English product copy, addressed through the same semantic keys as the German catalog. */
export const tools = Object.freeze({
  nativeUpdateRequired:
    "Updates require a native installation or an npm installation managed by AgentPier.",
  installationChanged: "The CLI installation changed during the update.",
  cliUpdated:
    "CLI updated and verified. New or reloaded sessions use the updated version.",
  invalidGithubRedirect: "Invalid GitHub download redirect.",
  forbiddenGithubRedirect: "GitHub download redirect to a disallowed target.",
  publicDownloadFailed: "The public GitHub download failed.",
  downloadHttpFailed: (status) =>
    `GitHub download failed (HTTP ${status}). Please try again later.`,
  downloadTooLarge: "The GitHub download is too large.",
  unsafeArchivePath: "The archive contains an unsafe path.",
  archiveSizeExceeded: "The archive exceeds the allowed size.",
  specialArchiveFilesForbidden: "Links and special files are not allowed in the archive.",
  duplicateArchivePaths: "The archive contains duplicate paths.",
  invalidZipArchive: "The ZIP archive is invalid.",
  encryptedArchivesForbidden: "Encrypted archives are not allowed.",
  invalidTarSize: "The tar archive contains invalid size information.",
  tarTooLarge: "The tar archive is too large.",
  tarMetadataTooLarge: "The tar archive contains metadata that is too large.",
  invalidPaxData: "Invalid PAX archive data.",
  unsupportedPaxData: "Unsupported PAX archive data.",
  invalidOrOversizedTar: "The tar archive is invalid or too large.",
  archiveEntryLimit: "The archive contains too many entries.",
  unexpectedTarData: "The tar archive contains unexpected additional data.",
  invalidTarChecksum: "The tar archive checksum is invalid.",
  incompleteOrOversizedTar: "The tar archive is incomplete or too large.",
  archiveCliNotRegular: "The archive does not contain a regular GitHub CLI.",
  incompleteTar: "The tar archive is incomplete.",
  archiveTooLarge: "The archive is too large.",
  archiveCliOrLicenseMissing:
    "The archive does not contain a complete GitHub CLI with license.",
  githubCliPlatformUnsupported:
    "GitHub CLI is only supported here on macOS and Linux with ARM64 or x64.",
  invalidGithubRelease: "The GitHub release data is invalid.",
  releasePackageMissing:
    "The expected official GitHub release package is missing or invalid.",
  releaseChecksumMissing: "The official release checksum is missing or ambiguous.",
  releaseChecksumMismatch:
    "The GitHub release checksum does not match. Nothing was installed.",
  installationTimeout: "Installation timed out. Please check the network and try again.",
  installerUnavailable:
    "The installer could not be started. Please check Node.js and npm.",
  installationExitFailure: (code) =>
    `Installation failed (exit ${code}). Please check the network, free disk space and write permissions.`,
  installationExitFailureWithHint: (code, hint) =>
    `Installation failed (exit ${code}, ${hint}). Please check the network, free disk space and write permissions.`,
  installationDirectoryInvalid: "The installation folder is not a regular directory.",
  directInstallPlatformNotice:
    "Direct installation is supported on macOS and Linux with ARM64 or x64.",
  npmUnavailable: "npm was not found. Please set up Node.js with npm on the server.",
  installationInterrupted:
    "The installation was interrupted by a server restart. Please try again.",
  serviceStopping: "The installation service is stopping.",
  installationAlreadyRunning: "A CLI installation is already running. Please wait.",
  installationDirectoryExists:
    "An installation folder already exists. Please check it manually; existing files are preserved.",
  installingPackage: "Installing official package …",
  statusSaveFailureSuffix: " The status could not be saved.",
  downloadingVerifiedRelease:
    "Downloading official GitHub release and verifying it with SHA-256 …",
  checkingInstalledVersion: "Checking installation with --version …",
  installedCliNotExecutable: "Verification failed: the installed CLI is not executable.",
  installedVersionCheckFailed: "The version check of the installed CLI failed.",
  installedReleaseVersionMismatch:
    "The GitHub CLI version does not match the verified release.",
  githubCliInstalled:
    "GitHub CLI installed and verified. It is available to new sessions.",
  cliInstalled: "CLI installed and verified. You can start a session.",
  installationTargetFailed:
    "Installation failed. Please check the target folder and write permissions.",
  installationAbortedOrTimedOut: "Installation was cancelled or timed out.",
  installationAborted: "Installation was cancelled.",
  installationShutdown: "Installation was cancelled while the server was stopping.",
  cliInstalledElsewhere:
    "The CLI has since been installed by other means. The existing installation is preserved.",
  unexpectedGithubRedirect: "Unexpected GitHub download redirect.",
  githubRedirectLimit: "Too many GitHub download redirects.",
  duplicatePaxData: "Duplicate PAX archive data.",
  alreadyInstalled: "This CLI is already installed.",
  invalidInstallerMethod: "Invalid installer method.",
  nativeRedirectNotOfficial:
    "Native installer redirect is not an official bootstrap URL.",
  nativeDownloadFailed: (status) => `Native installer download failed (HTTP ${status}).`,
  nativeDownloadTooLarge: "Native installer exceeds its download limit.",
  nativeScriptInvalid: "The official native installer response is not a shell script.",
  nativeBinaryOutsideHome:
    "The native installer did not create a binary inside the server home.",
  nativeVersionCheckFailed: "The native CLI version check failed.",
});
