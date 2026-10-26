export const settingsPageCopy = {
  settingsFormFieldLabel: "Standard-Arbeitsverzeichnis",
  iconButtonAriaLabel: "Standardordner auswählen",
  defaultDirectoryDescription:
    "Neue Sessions starten in diesem Ordner. Repositories werden standardmäßig in Unterordner dieses Ordners geklont. Ein ausdrücklich gewählter Ordner hat Vorrang.",
  settingsSaved: "Einstellungen gespeichert.",
  directoryRequired: "Gib ein Standard-Arbeitsverzeichnis an.",
  agentsNotApplied: "Agenten wurden nicht umgeschaltet. Siehe die Agenten-Diagnose.",
  autoResumeLabel: "Unterbrochene Sessions automatisch fortsetzen",
  autoResumeDescription:
    "Nach einem Neustart oder dem Verlust des Terminal-Servers setzt AgentPier jede unterbrochene Session nacheinander mit ihrer eigenen Unterhaltung fort. Von dir beendete Sessions bleiben beendet.",
  loadingSettings: "Einstellungen werden geladen …",
  saveSettings: "Einstellungen speichern",
};

export const settingsHubCopy = {
  backTo: (tab) => `Zurück zu ${tab}`,
  subpageOf: (tab) => `Einstellungen · ${tab}`,
  mcpClients: (count) =>
    count === 1 ? "1 verbundener Client" : `${count} verbundene Clients`,
  mcpUnavailable: "Nicht verfügbar",
  // Gruppe „Funktionen“ im Tab Allgemein: Agenten schaltet Agenten › Laufzeit.
  featuresGroup: "Funktionen",
  featureAgentsSub: "Ein- und ausschalten unter Agenten › Laufzeit",
  // Gruppe „Umgezogen“ im Tab Allgemein (für zwei Versionen).
  movedGroup: "Umgezogen",
  movedHint:
    "Diese Einträge bleiben zwei Versionen lang hier, damit gewohnte Wege nicht ins Leere laufen.",
  movedAgents: "Agentendienst, Updates, Träumen, Erweitert",
  movedAgentsSub: "Jetzt unter Agenten › Laufzeit",
  movedConnections: "SSH-Zugänge, Geheimnisse, GitHub-Zugänge, Modell-Zugänge",
  movedConnectionsSub: "Jetzt unter Zugänge",
  movedMcp: "MCP & Zugriffe (AgentPier für CLIs)",
  movedMcpSub: "Jetzt unter CLIs & Erweiterungen › AgentPier als MCP",
  storageSub:
    "Systemstatus und Aufräumen: Update-Sicherungen, Verläufe, Abhängigkeiten der Agenten",
  storageFree: (size) => `${size} frei`,
  diagnosticsOk: "In Ordnung",
  diagnosticsFailed: (count) => (count === 1 ? "1 Fehler" : `${count} Fehler`),
  diagnosticsWarnings: (count) => (count === 1 ? "1 Warnung" : `${count} Warnungen`),
  checkedAt: (when) => `Geprüft am ${when}`,
  lastBackup: (when) => `Letzte Sicherung ${when}`,
  installedVersion: (version) => `Installierte Version ${version}`,
  updateAvailable: (version) => `${version} verfügbar`,
  upToDate: "Aktuell",
  auditSub: "Besitzer, Benutzer, System, MCP",
};
