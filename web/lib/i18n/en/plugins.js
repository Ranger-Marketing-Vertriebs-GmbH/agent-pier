export const installedPluginsCopy = {
  installedPluginsHeading: "Installed plugins",
  sectionHeadingLabel: " found",
  pluginListSearch: "Search installed plugins",
  extensionScope: "Version not specified",
  toggleNotice: (value1, value2) => `${value1} was ${value2}.`,
  updatedNotice: (value1) => `${value1} was updated.`,
  extensionEmpty: "No matching installed plugins.",
};
export const marketplacesCopy = {
  marketplacesHeading: "Marketplaces",
  sectionHeadingLabel: " sources",
  buttonOnClick: (value1) => `${value1} was updated.`,
  extensionInstallOnSubmit: "Marketplace added.",
  extensionWide: "Marketplace source",
  extensionWidePlaceholder: "owner/repo or HTTPS URL",
  marketplaceSourceDescription:
    "Use the plugin provider’s source. Plugins are installed through the selected CLI and may execute code and hooks.",
  addMarketplace: "Add marketplace",
};
export const pluginCatalogCopy = {
  catalogHeading: "Discover plugins",
  sectionHeadingLabel: " results",
  searchPlugins: "Search plugins",
  filterMarketplace: "Filter marketplace",
  extensionFieldsOption: "All marketplaces",
  buttonOnClick: (value1) => `${value1} was installed.`,
  extensionEmpty: "No matching plugins. Add a marketplace or change the search filter.",
  extensionSectionLabel: "Plugin catalog",
};
export const pluginsPageCopy = {
  pluginsPageEyebrow: "WORKSPACE / PLUGINS",
  pluginsPageSubtitle: "Native CLI extensions",
  pluginsPageTitle: "Plugins & Marketplace",
  pluginsPageDescription: "Discover plugins and manage them for your CLI profile.",
};
export const profilePluginsCopy = {
  pluginsLoading: "Loading plugins and marketplaces …",
  extensionNotice: "CLI is applying the change …",
  confirmPluginRemoval: (value1) => `Remove plugin “${value1}” from this profile?`,
  confirmMarketplaceRemoval: (value1) =>
    `Remove marketplace “${value1}” from this profile? The CLI determines how associated plugins are handled.`,
  buttonOnClick: (value1) => `${value1} was removed.`,
  extensionInstallOnSubmit: "Plugin package added.",
  extensionInstallHeading: "Add npm plugin",
  extensionWide: "npm package",
  extensionWidePlaceholder: "@scope/plugin@1.2.3",
  packageSourceDescription:
    "Enter package names from the OpenCode community, optionally with a version. OpenCode plugins can execute code.",
  installPackage: "Install package",
};
export const useProfilePluginsCopy = {
  restartNoticeSuffix: " Changes will load when the CLI next starts.",
};
