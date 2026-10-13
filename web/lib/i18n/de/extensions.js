export const extensionsPageCopy = {
  title: "Erweiterungen",
  description: "Skills und Plugins für jedes CLI-Profil.",
};
export const extensionsHubCopy = {
  profiles: "CLI-Profile",
  sharedProfile: "Alle Accounts dieser CLI",
  switchProfile: (name) => `CLI-Profil wechseln, aktuell ${name}`,
  tabs: "Erweiterungen",
  mcpServers: "MCP-Server",
  serversForCli: (count, cli) => `${count} für ${cli}`,
  tabSkills: "Skills",
  tabPlugins: "Plugins",
  tabMarketplaces: "Marketplaces",
  tabAgents: "Agenten",
  panelSubtitle: (value1) => `Profil ${value1}`,
  rowActions: (value1) => `Aktionen für ${value1}`,
  viewLabel: "Ansicht",
  installedView: (value1) => `Installiert · ${value1}`,
  discoverView: (value1) => `Entdecken · ${value1}`,
  browseCatalog: "Katalog durchsuchen",
  headStatus: "Status",
  headSource: "Quelle",
  headVersion: "Version",
  installedHere: "Hier installiert",
  readOnly: "Schreibgeschützt",
  pluginActive: "Aktiv",
  pluginDisabled: "Deaktiviert",
  pluginDetails: "Details",
  pluginDetailsLabel: (name) => `Details zu ${name}`,
  backToPlugins: "Zurück zu Plugins",
  path: "Pfad",
  available: "Verfügbar",
  builtin: "Integriert",
  customMarketplace: "Eigene Quelle",
  pluginCount: (value1) => `${value1} Plugins`,
};
export const profileExtensionsCopy = {
  extensionsLoading: "Skills werden geladen …",
  extensionScopeNote:
    "Codex-Skills werden im Benutzerordner geteilt und gelten für alle Codex-Profile.",
  confirmSkillRemoval: (value1) =>
    `Den hier installierten Skill „${value1}“ mit seinen Dateien entfernen?`,
  removedNotice: (value1) => `${value1} wurde entfernt.`,
  skillsHeading: "Skills",
  extensionSectionPlaceholder: "Name, Beschreibung oder Bereich",
  noMatchingSkills: "Keine Skills passen zur Suche.",
  noSkills: "In den bekannten Profilordnern wurden keine Skills gefunden.",
};
export const skillInstallFormCopy = {
  fileRequired: "Bitte zuerst eine Skill-Datei auswählen.",
  installedNotice:
    "Skill installiert. Starte die CLI neu, falls sie den Skill noch nicht anzeigt.",
  destinationLabel: "Zielordner",
  uploadSource: "Datei hochladen",
  githubSource: "GitHub-Link",
  extensionFieldsOnDrop: "Bitte genau eine ZIP-Datei oder SKILL.md ablegen.",
  extensionFieldsDescription:
    "ZIP mit SKILL.md und Begleitdateien oder einzelne SKILL.md hier ablegen.",
  extensionWide: "Öffentlicher GitHub-Link",
  archiveLimitsDescription:
    "Ein Skill pro Paket · maximal 10 MiB ZIP, 20 MiB entpackt. Bestehende Ordner werden nicht überschrieben. Installationsskripte werden nicht ausgeführt.",
  installingSkill: "Skill wird installiert …",
};
export const extensionInputsCopy = {
  fileReadFailed: "Die Datei konnte nicht gelesen werden.",
};
export const useProfileExtensionsCopy = {
  fileTooLarge: "Die Skill-Datei darf höchstens 10 MiB groß sein.",
  unsupportedFileType: "Bitte SKILL.md oder eine ZIP-Datei auswählen.",
};
