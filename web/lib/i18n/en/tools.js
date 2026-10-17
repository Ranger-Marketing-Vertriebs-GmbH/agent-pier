export const toolInstallerCopy = {
  versionLabel: (version) => `Version ${version}`,
  versionUnknown: "Version unknown",
  updateRequiredBadge: "Update required",
  minimumVersion: (required) => `Requires ${required} or later`,
  installedVersion: (version) => `Installed: ${version}`,
  updateRequiredNotice: (name, found, required) =>
    `${name} ${found} is older than the minimum version ${required}. Update the CLI to start a session.`,
  versionUnknownNotice: (name) =>
    `AgentPier could not read the ${name} version. The session starts anyway; if something does not work, update the CLI.`,
  updateCli: "Update CLI",
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
