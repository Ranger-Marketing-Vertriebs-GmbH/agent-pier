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
  skillVisibilityNotice: (scope) =>
    `${scope}. Angezeigt werden bekannte Benutzer- und Profilordner; projekt- und pluginabhängige Skills sind nicht vollständig erfasst. Entfernen ist nur für hier installierte Skills möglich.`,
  packageOrigin: (name, version) =>
    `Aus dem MCP-Paket ${name}@${version} · wird mit ihm aktualisiert und entfernt`,
  githubOrigin: (repository, kind, ref, commit) =>
    kind === "commit"
      ? `GitHub ${repository} · Commit ${commit.slice(0, 12)}`
      : `GitHub ${repository} · ${kind === "tag" ? "Tag" : "Branch"} ${ref} · Commit ${commit.slice(0, 12)}`,
  skillScopes: {
    sharedUserSkillScope: "Benutzer · von Codex und kompatiblen CLIs geteilt",
    codexProfileSkillScope: "Codex-Profil · vorhandene Skills",
    systemReadOnlyScope: "System · schreibgeschützt",
    claudeProfileScope: "Claude-Profil",
    claudeUserScope: "Claude-Benutzer",
    openCodeProfileScope: "OpenCode-Profil",
    openCodeUserScope: "OpenCode-Benutzer",
  },
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
  githubRefHint:
    "Ein Ordnerlink kann nach /tree/ einen Branch, einen Tag oder einen vollständigen Commit-SHA nennen. AgentPier installiert den Commit, auf den er jetzt zeigt, und merkt ihn sich.",
  archiveLimitsDescription:
    "Ein Skill pro Paket · maximal 10 MiB ZIP, 20 MiB entpackt. Bestehende Ordner werden nicht überschrieben. Installationsskripte werden nicht ausgeführt. Vor der Installation prüft AgentPier die Dateien offline und zeigt das Ergebnis.",
  installingSkill: "Skill wird installiert …",
};
export const extensionInputsCopy = {
  fileReadFailed: "Die Datei konnte nicht gelesen werden.",
};
export const useProfileExtensionsCopy = {
  fileTooLarge: "Die Skill-Datei darf höchstens 10 MiB groß sein.",
  unsupportedFileType: "Bitte SKILL.md oder eine ZIP-Datei auswählen.",
};
