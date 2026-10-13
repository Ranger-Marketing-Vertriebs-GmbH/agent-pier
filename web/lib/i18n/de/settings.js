export const settingsPageCopy = {
  settingsFormFieldLabel: "Standard-Arbeitsverzeichnis",
  iconButtonAriaLabel: "Standardordner auswählen",
  defaultDirectoryDescription:
    "Neue Sitzungen starten in diesem Ordner. Repositories werden standardmäßig in Unterordner dieses Ordners geklont. Ein ausdrücklich gewählter Ordner hat Vorrang.",
  settingsSaved: "Einstellungen gespeichert.",
  directoryRequired: "Gib ein Standard-Arbeitsverzeichnis an.",
  agentsNotApplied: "Agenten wurden nicht umgeschaltet. Siehe die Agenten-Diagnose.",
  autoResumeLabel: "Unterbrochene Sitzungen automatisch fortsetzen",
  autoResumeDescription:
    "Nach einem Neustart oder dem Verlust des Terminal-Servers setzt AgentPier jede unterbrochene Sitzung nacheinander mit ihrer eigenen Unterhaltung fort. Von dir beendete Sitzungen bleiben beendet.",
  loadingSettings: "Einstellungen werden geladen …",
  saveSettings: "Einstellungen speichern",
};

export const settingsHubCopy = {
  backTo: (tab) => `Zurück zu ${tab}`,
  subpageOf: (tab) => `Einstellungen · ${tab}`,
  appGroup: "App",
  mcpSub: "Coding-CLI mit AgentPier verbinden",
  mcpClients: (count) =>
    count === 1 ? "1 verbundener Client" : `${count} verbundene Clients`,
  mcpUnavailable: "Nicht verfügbar",
  remoteRestart: "Neustart nötig",
  remoteSub: "Von anderen Geräten erreichen",
  sshSub: "Schlüssel und Hosts",
  githubSub: "Token für Klone und Pull Requests",
  centralTitle: "Provider-Zugänge, MCP-Server",
  diagnosticsOk: "In Ordnung",
  diagnosticsFailed: (count) => (count === 1 ? "1 Fehler" : `${count} Fehler`),
  diagnosticsWarnings: (count) => (count === 1 ? "1 Warnung" : `${count} Warnungen`),
  checkedAt: (when) => `Geprüft am ${when}`,
  lastBackup: (when) => `Letzte Sicherung ${when}`,
  installedVersion: (version) => `Installierte Version ${version}`,
  updateAvailable: (version) => `${version} verfügbar`,
  upToDate: "Aktuell",
  auditSub: "Benutzer, System, MCP",
};
