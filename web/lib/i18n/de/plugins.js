export const installedPluginsCopy = {
  installedPluginsHeading: "Installierte Plugins",
  sectionHeadingLabel: " gefunden",
  pluginListSearch: "Installierte Plugins suchen",
  extensionScope: "Version nicht angegeben",
  toggleNotice: (value1, value2) => `${value1} wurde ${value2}.`,
  updatedNotice: (value1) => `${value1} wurde aktualisiert.`,
  extensionEmpty: "Keine passenden installierten Plugins.",
};
export const marketplacesCopy = {
  defaultMarketplace: "Codex-Standard-Marketplace",
  builtinDescription: "Von Codex bereitgestellt. Wähle Plugins aus dem Katalog aus.",
  marketplacesHeading: "Marketplaces",
  sectionHeadingLabel: " Quellen",
  buttonOnClick: (value1) => `${value1} wurde aktualisiert.`,
  extensionInstallOnSubmit: "Marketplace hinzugefügt.",
  extensionWide: "Marketplace-Quelle",
  extensionWidePlaceholder: "owner/repo oder HTTPS-URL",
  marketplaceSourceDescription:
    "Verwende die Quelle des Plugin-Anbieters. Plugins werden über die ausgewählte CLI installiert und können Code und Hooks ausführen.",
  addMarketplace: "Marketplace hinzufügen",
};
export const pluginCatalogCopy = {
  catalogHeading: "Plugins entdecken",
  sectionHeadingLabel: " Treffer",
  searchPlugins: "Plugins suchen",
  filterMarketplace: "Marketplace filtern",
  extensionFieldsOption: "Alle Marketplaces",
  buttonOnClick: (value1) => `${value1} wurde installiert.`,
  extensionEmpty:
    "Keine passenden Plugins. Füge einen Marketplace hinzu oder ändere den Suchfilter.",
  extensionSectionLabel: "Plugin-Katalog",
};
export const pluginsPageCopy = {
  pluginsPageEyebrow: "WORKSPACE / PLUGINS",
  pluginsPageSubtitle: "Native CLI-Erweiterungen",
  pluginsPageTitle: "Plugins & Marketplace",
  pluginsPageDescription: "Plugins entdecken und für dein CLI-Profil verwalten.",
};
export const profilePluginsCopy = {
  catalogAccount: "Marketplace-Konto",
  catalogAccountDescription:
    "Wähle ein bei Codex angemeldetes Konto. Plugins aus dem Standard-Marketplace werden für dieses Konto installiert.",
  pluginsLoading: "Plugins und Marketplaces werden geladen …",
  extensionNotice: "CLI führt die Änderung aus …",
  confirmPluginRemoval: (value1) => `Plugin „${value1}“ aus diesem Profil entfernen?`,
  confirmMarketplaceRemoval: (value1) =>
    `Marketplace „${value1}“ aus diesem Profil entfernen? Die CLI bestimmt, wie zugehörige Plugins behandelt werden.`,
  buttonOnClick: (value1) => `${value1} wurde entfernt.`,
  extensionInstallOnSubmit: "Plugin-Paket hinzugefügt.",
  extensionInstallHeading: "npm-Plugin hinzufügen",
  extensionWide: "npm-Paket",
  extensionWidePlaceholder: "@scope/plugin@1.2.3",
  packageSourceDescription:
    "Paketnamen aus der OpenCode-Community eintragen, optional mit Version. OpenCode-Plugins können Code ausführen.",
  installPackage: "Paket installieren",
};
export const useProfilePluginsCopy = {
  restartNoticeSuffix: " Änderungen werden beim nächsten CLI-Start geladen.",
};
