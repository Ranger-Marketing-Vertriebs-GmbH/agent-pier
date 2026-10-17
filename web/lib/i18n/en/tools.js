export const toolInstallerCopy = {
  externalUpdateNotice: (name, found, required) =>
    `${name} ${found} is older than the minimum version ${required}. AgentPier did not install this copy and cannot update it: update it with the package manager that installed it (for example Homebrew or npm). Sessions still start.`,
  versionLabel: (version) => `Version ${version}`,
  versionUnknown: "Version unknown",
  updateRequiredBadge: "Update required",
  minimumVersion: (required) => `Requires ${required} or later`,
  installedVersion: (version) => `Installed: ${version}`,
  pinnedVersion: (version) => `Available: ${version}`,
  chromeForTesting: "Google's Chrome for Testing, version pinned in AgentPier",
  chromiumInstallationDescription:
    "AgentPier downloads the browser itself, checks its size and SHA-256 and keeps it in its own folder. No Homebrew, no administrator rights.",
  updateRequiredNotice: (name, found, required) =>
    `${name} ${found} is older than the minimum version ${required}. Update the CLI to start a session.`,
  versionUnknownNotice: (name) =>
    `AgentPier could not read the ${name} version. The session starts anyway; if something does not work, update the CLI.`,
  updateCli: "Update CLI",
  updateBrowser: "Update browser",
  browserUpdateDescription:
    "Downloads the newer agent browser version pinned in AgentPier. Running agent browsers keep the previous version until the agent service restarts.",
  browserUpdating: "Updating the browser …",
  browserUpdated: "Browser updated",
  browserUpdateReady: "Browser update",
  updateTitle: (name) => `Update ${name}`,
  updateDescription:
    "Updates the CLI on the AgentPier server. Running sessions continue; new or reloaded sessions use the updated version.",
  migrationDescription:
    "AgentPier installed this CLI through npm. It will first be migrated to a native installation using the official installer. Previous program files are retained for running sessions; accounts and conversations are preserved.",
  backgroundUpdateDescription:
    "You can close this window. The update continues in the background.",
  migrateNow: "Migrate & update",
  updateNow: "Update now",
  updating: "Updating CLI …",
  updated: "CLI updated",
  updateReady: "CLI update",
  nativeInstaller: "Official native installer",
  nativeInstallationDescription:
    "Uses the official installation script in the AgentPier server’s user directory. The CLI retains its native update mechanism; Claude and OpenCode may update automatically. Account sign-ins remain in their separate profiles. Existing installations are not replaced.",
  serverInstallationDescription:
    "Installation takes place on the computer running AgentPier (the server).",
  installationPreparing: "Preparing installation …",
  toolInstallDetailsText: "Destination directory on server",
  isolatedInstallationDescription:
    "AgentPier installs the CLI in its own directory. Existing installations are preserved.",
  backgroundInstallationDescription:
    "You can close this window. Installation will continue in the background.",
  toolInstallReason: "Another CLI is being installed. Please wait for it to finish.",
  refreshInstallationStatus: "Refresh status",
  refreshingInstallationStatus: "Refreshing status …",
  githubCredentials: "GitHub connections",
  startingInstallation: "Starting installation …",
  reinstallationReady: "CLI missing — ready to reinstall",
  retryInstallation: "Install again",
};
export const useToolInstallationCopy = {
  installationUnavailable: "No installation is available for this tool.",
  cliNotDetected: "The CLI has not been detected yet. Please refresh the status.",
};
