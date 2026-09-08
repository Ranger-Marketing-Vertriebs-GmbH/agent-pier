export const extensionsPageCopy = {
  eyebrow: "WORKSPACE / ERWEITERUNGEN",
  subtitle: "Native CLI-Konfiguration",
  title: "MCP & Skills",
  description: "Gemeinsame Werkzeuge, Skills und Agenten für jede CLI.",
};
export const mcpFormCopy = {
  extensionAddSummary: "MCP-Server hinzufügen",
  extensionAddOnSubmit:
    "MCP-Konfiguration gespeichert. Sie wird beim nächsten CLI-Start geladen.",
  commandLabel: "MCP-Name",
  extensionFieldsPlaceholder: "mein-server",
  localTransport: "Lokaler Befehl · stdio",
  remoteTransport: "Remote-URL · HTTP",
  extensionWidePlaceholder: "npx, uvx oder ausführbare Datei",
  argumentsJsonLabel: "Argumente als JSON",
  environmentJsonLabel: "Umgebungsvariablen als JSON",
  mcpUrlLabel: "MCP-URL",
  headersJsonLabel: "HTTP-Header als JSON",
  secretStorageDescription:
    "Argumente, Variablen und Header-Werte bleiben nach dem Speichern verborgen. Für OAuth-Anmeldung verwende die jeweilige CLI.",
  savingMcp: "MCP wird gespeichert …",
};
export const profileExtensionsCopy = {
  extensionsLoading: "MCP und Skills werden geladen …",
  extensionScopeNote:
    "Codex-Skills werden im Benutzerordner geteilt und gelten für alle Codex-Profile.",
  confirmMcpRemoval: (value1) =>
    `Die aktive MCP-Konfiguration „${value1}“ aus diesem Profil entfernen?`,
  confirmSkillRemoval: (value1) =>
    `Den hier installierten Skill „${value1}“ mit seinen Dateien entfernen?`,
  removedNotice: (value1) => `${value1} wurde entfernt.`,
  mcpHeading: "MCP-Server",
  configuredCountSuffix: " konfiguriert",
  mcpCommandSummary: (value1, value2) => `${value1} · ${value2} Argumente`,
  savedValuesPrefix: "Zugangswerte gespeichert · ",
  variableCountSuffix: "Variablen, ",
  headerCountSuffix: " Header",
  noMcpServers: "In diesem Profil sind noch keine MCP-Server konfiguriert.",
  skillsHeading: "Skills",
  skillsFoundSuffix: " gefunden",
  extensionSectionPlaceholder: "Name, Beschreibung oder Bereich",
  extensionScope: " · Schreibgeschützt",
  noMatchingSkills: "Keine Skills passen zur Suche.",
  noSkills: "In den bekannten Profilordnern wurden keine Skills gefunden.",
};
export const skillInstallFormCopy = {
  fileRequired: "Bitte zuerst eine Skill-Datei auswählen.",
  installedNotice:
    "Skill installiert. Starte die CLI neu, falls sie den Skill noch nicht anzeigt.",
  destinationLabel: "Zielordner",
  uploadSource: "Datei hochladen oder ablegen",
  githubSource: "Von öffentlichem GitHub-Link laden",
  extensionFieldsOnDrop: "Bitte genau eine ZIP-Datei oder SKILL.md ablegen.",
  extensionFieldsDescription:
    "ZIP mit SKILL.md und Begleitdateien oder einzelne SKILL.md hier ablegen.",
  extensionWide: "Öffentlicher GitHub-Link",
  archiveLimitsDescription:
    "Ein Skill pro Paket · maximal 10 MiB ZIP, 20 MiB entpackt. Bestehende Ordner werden nicht überschrieben. Installationsskripte werden nicht ausgeführt.",
  installingSkill: "Skill wird installiert …",
};
export const extensionInputsCopy = {
  invalidJson: (value1) => `${value1}: Bitte gültiges JSON eingeben.`,
  jsonShapeRequired: (value1, value2) => `${value1}: ${value2} wird benötigt.`,
  fileReadFailed: "Die Datei konnte nicht gelesen werden.",
};
export const useProfileExtensionsCopy = {
  fileTooLarge: "Die Skill-Datei darf höchstens 10 MiB groß sein.",
  unsupportedFileType: "Bitte SKILL.md oder eine ZIP-Datei auswählen.",
};
