/** English product copy, addressed through the same semantic keys as the German catalog. */
export const accounts = Object.freeze({
  waitForPluginOperation: "Please wait for the running plugin operation to finish.",
  stopBeforeKeyChange: "Please stop this account's sessions before changing the key.",
  stopBeforeDelete: "Please stop this account's sessions first.",
  localAccountName: (toolName) => `${toolName} · Local`,
  notFound: "Account not found.",
  localProfileReadOnly: "The local profile is not modified here.",
  invalidApiKey: "Invalid API key.",
  invalidLaunchMode: "Invalid launch mode for this CLI tool.",
  launchModeRequiresWorkSession:
    "Launch modes apply only to new work sessions, not to sign-in.",
  managedLoginRequired: "Please create a separate account for sign-in.",
  apiKeyLoginConflict:
    "This profile uses an API key. For browser sign-in, please create an account without an API key.",
  cliNotInstalled: (toolName) => `${toolName} is not installed.`,
  supportedShellUnavailable: "No supported local shell is available.",
  generatedProfileReadOnly: "Generated provider profiles cannot be edited.",
  keyRotationOrRemoval: "Choose either key rotation or key removal.",
  providerSwitchKeyRequired:
    "Supply a new API key or remove the saved key when switching providers.",
  generatedProfileNotRemovable:
    "Generated provider profiles retain session history and cannot be removed as accounts.",
  invalidProfileModel: "Invalid profile model.",
  providerProfileNoOAuth:
    "Provider profiles use API keys and cannot start an OAuth login.",
});
