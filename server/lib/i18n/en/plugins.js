/** English product copy, addressed through the same semantic keys as the German catalog. */
export const plugins = Object.freeze({
  invalidCatalogAccount: "Please choose a valid Codex account for the default catalog.",
  defaultCatalogSource: "Native Codex default catalog of the selected account",
  nativeMarketplaceSource: "Provided by the native Codex catalog",
  remoteCatalogEmpty:
    "No default plugins are available for this account. Choose an account signed in to Codex and reload.",
  remoteCatalogUnavailable:
    "The default catalog of the selected account could not be loaded. Local plugins remain available.",
  serviceStopping: "Plugin management is stopping.",
  commandTimeout: "The native plugin command timed out.",
  catalogSelectionRequired: "Please choose a plugin from the marketplace catalog.",
  invalidMarketplaceName: "Invalid marketplace name.",
  npmPackageRequired: "Please enter an npm package name with an optional version.",
  publicRepositoryRequired: "Please enter a public HTTPS repository or owner/repo.",
  marketplaceUrlRestricted:
    "Marketplace URLs must use public HTTPS without credentials, parameters or a custom port.",
  pathOutsideProfile: "The plugin path is outside the profile.",
  linkedConfigReadOnly: "Linked plugin configuration paths are read-only here.",
  invalidConfigFile: "The plugin configuration is too large or not a regular document.",
  duplicateConfigKeys:
    "Duplicate configuration keys must first be fixed in the CLI profile.",
  invalidExistingConfig:
    "The existing plugin configuration is invalid and was not changed.",
  shellManagementUnavailable: "Plugin management is not available for shell sessions.",
  restartRequiredNotice:
    "Changes apply to new CLI sessions. Sessions that are already running remain unchanged.",
  unsupportedCliJson:
    "The CLI does not return supported plugin JSON. Please check the CLI version.",
  unsupportedEntryFormat: "A plugin entry has an unsupported format.",
  externalSourceScope: "External source · manageable only in the native profile",
  openCodeConfigurationNotice:
    "OpenCode uses npm packages and local plugins, without managed marketplaces. Server and TUI configuration are included. Changes load in new CLI sessions.",
  openCodeInstallerUnavailable:
    "This OpenCode version does not support a native plugin install command yet.",
  unsupportedPluginList: "This native plugin list format is not supported yet.",
  unsupportedMarketplaceList: "This native marketplace list format is not supported yet.",
  codexActivationNotice:
    " Enabling and updating individual Codex plugins is not available in this CLI management; /plugins provides native activation.",
  unknownAction: "Unknown plugin action.",
  operationAlreadyRunning: "A plugin action is already running for this CLI profile.",
  marketplacesUnsupported: "This CLI does not support managed marketplaces.",
  marketplaceNotFound: "Marketplace not found.",
  detectedMarketplaceReadOnly:
    "This automatically detected marketplace is read-only here.",
  installationUnsupported: "This CLI version does not support plugin installation here.",
  actionUnsupported: "This plugin action is not supported by the native CLI.",
  catalogPluginNotFound: "Plugin not found in the marketplace catalog.",
  notFound: "Plugin not found.",
  readOnly: "This plugin is read-only here.",
  configurationUpdated:
    "Plugin configuration updated. New CLI sessions pick up the change.",
  missingOrReadOnly: "Plugin not found or read-only.",
  multipleVersionsConfigured:
    "Multiple versions of this plugin are configured. Please clean up the native configurations first.",
  configChanged: "The plugin configuration was changed concurrently. Please reload.",
  shutdownCancelled: "Plugin management was stopped during shutdown.",
  commandOutputLimit: "The native plugin command produced too much output.",
  commandFailed: "The native plugin command failed.",
  externalPlugin: "External plugin",
  globalPackageScope: "npm package · global CLI configuration",
  automaticLocalPlugin: "Automatically loaded local plugin",
  claudeMarketplaceRemovalNotice:
    " Removing a marketplace uninstalls its plugins in Claude. Removing an individual plugin preserves its saved data.",
  alreadyInstalled: "This plugin is already installed.",
});
