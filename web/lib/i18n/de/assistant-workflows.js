export const assistantWorkflowCopy = {
  title: "Projekte und Coding-Aufträge",
  hint: "Wähle die Projekte und Pipelines, die dieser Agent verwenden darf. Projektwissen bleibt von persönlichen Notizen getrennt.",
  projects: "Freigegebene Projekte",
  pipelines: "Freigegebene Pipelines",
  projectsIntro:
    "Freigegebene Projekte stehen für Projektwissen und Coding-Aufträge bereit. Direkter Ordnerzugriff lässt den Agenten zusätzlich Dateien im Projektordner lesen oder lesen und ändern.",
  projectsFoldersIntro:
    "Agenten von Benutzern bekommen weder Projektwissen noch Coding-Aufträge. Ein angehaktes Projekt gibt dem Agenten nur direkten Zugriff auf seinen Ordner: Dateien lesen oder lesen und ändern.",
  folderLegend: "Direkter Ordnerzugriff",
  folderLevels: {
    none: "Keiner",
    read: "Lesen",
    write: "Lesen und schreiben",
  },
  folderHints: {
    none: "Nur Projektwissen und Coding-Aufträge.",
    read: "Listet, liest und durchsucht Dateien im Ordner.",
    write:
      "Legt außerdem Dateien an und ändert sie. Jede Änderung wird mit Pfad und Größe protokolliert; .git bleibt gesperrt.",
  },
  folderWarning:
    "Der Agent ändert Dateien direkt, ohne Freigabe pro Änderung. Gelesene Inhalte können ihn steuern; prüfe Änderungen mit der Versionsverwaltung.",
  folderSummary: (count) =>
    count === 1 ? "1 mit Ordnerzugriff" : `${count} mit Ordnerzugriff`,
  noResources:
    "Noch keine Einträge vorhanden. Richte zuerst Projekte und Pipelines in AgentPier ein.",
  memoryWrite: "Vorschläge zum Ändern von Projektwissen erlauben",
  autonomous: "Ausgewählte Coding-Pipelines ohne zusätzliche Freigabe starten",
  publish: "Ausgewählten Pipelines das Veröffentlichen von Pull Requests erlauben",
  policyHint:
    "Änderungen am Projektwissen benötigen immer eine Freigabe. Coding-Aufträge ebenfalls, sofern oben nicht anders eingestellt. Speichern übernimmt die gewählte Pipeline- und Account-Konfiguration; nach Pipeline-Änderungen erneut speichern. Freigaben innerhalb der Pipeline bleiben erhalten.",
  removedProjects: (count) =>
    count === 1
      ? "1 freigegebenes Projekt gibt es nicht mehr; es wurde aus dem Zugriff dieses Agenten entfernt."
      : `${count} freigegebene Projekte gibt es nicht mehr; sie wurden aus dem Zugriff dieses Agenten entfernt.`,
  actions: "Aktionen und Coding-Aufträge",
  noActions:
    "Noch keine Aktionen. Bitte diesen Agenten im Chat, Projektwissen nachzuschlagen oder einen Coding-Auftrag vorzuschlagen.",
  coding: "Coding-Auftrag",
  codingSession: "Coding-Session",
  memory: "Änderung am Projektwissen",
  branch: "Ausgangsbranch",
  revision: "Erwartete Revision",
  runStatus: "Pipeline-Status",
  humanGate: "Erforderlichen Schritt prüfen",
  openRun: "Lauf und Artefakte öffnen",
  approve: "Aktion freigeben",
  decline: "Aktion ablehnen",
  cancel: "Coding-Auftrag stoppen",
  review: "Ergebnis als geprüft markieren",
  unknownHint:
    "Das Ergebnis ist unklar. Prüfe den zugehörigen Pipeline-Lauf oder das Projektwissen, bevor du einen neuen Auftrag erteilst. Als geprüft markieren schließt diesen Hinweis, ohne die Aktion zu wiederholen.",
  requestedBy: (name) => `Angefragt von Teammitglied ${name}`,
  memberApprovalHint:
    "Coding-Aufträge von Teammitgliedern brauchen immer deine Freigabe, auch mit Startberechtigung. Sie nutzen den Projektzugriff dieses Agenten.",
  pendingApprovals: "Wartet auf deine Freigabe",
  teamRequests: "Coding-Anfragen aus dem Team",
  diagnostics: {
    MEMORY_FORGOTTEN:
      "Der Text wurde entfernt, weil er endgültig aus dem Projektwissen vergessen wurde.",
    GRANT_REVOKED:
      "Projektzugriff oder Pipeline haben sich seit der Anfrage geändert. Es wurde nichts gestartet.",
    TEAM_STOPPED: "Zurückgezogen, weil das Team gestoppt wurde.",
  },
  states: {
    awaiting_approval: "Wartet auf Freigabe",
    approved: "Freigegeben",
    executing: "Wird gestartet",
    running: "Läuft",
    completed: "Abgeschlossen",
    failed: "Fehlgeschlagen",
    cancelled: "Abgebrochen",
    declined: "Abgelehnt",
    expired: "Freigabe abgelaufen",
    unknown: "Ergebnis unklar",
    reviewed: "Ergebnis geprüft",
  },
  chatNote: {
    started: (member) =>
      member ? `Coding-Lauf von ${member} gestartet` : "Coding-Lauf gestartet",
    completed: (member) =>
      member ? `Coding-Lauf von ${member} abgeschlossen` : "Coding-Lauf abgeschlossen",
    failed: (member) =>
      member ? `Coding-Lauf von ${member} fehlgeschlagen` : "Coding-Lauf fehlgeschlagen",
    cancelled: (member) =>
      member ? `Coding-Lauf von ${member} abgebrochen` : "Coding-Lauf abgebrochen",
  },
  runStates: {
    running: "Läuft",
    "awaiting-human": "Wartet auf deine Entscheidung",
    completed: "Abgeschlossen",
    failed: "Fehlgeschlagen",
    cancelled: "Abgebrochen",
  },
  nodeStates: {
    "awaiting-gate": "Wartet auf Freigabe",
    passed: "Bestanden",
    pending: "Ausstehend",
    running: "Läuft",
    completed: "Abgeschlossen",
    failed: "Fehlgeschlagen",
    cancelled: "Abgebrochen",
    skipped: "Übersprungen",
    "awaiting-human": "Wartet auf deine Entscheidung",
  },
  providerReasons: {
    unsupportedProvider: "Anbieter für Agenten nicht unterstützt",
    unsupportedProtocol: "Endpunkt-Protokoll nicht unterstützt",
    credentialsRequired: "Zugangsdaten erforderlich",
    modelConfiguration: "Modell mit mindestens 4.000 Kontext-Token konfigurieren",
    unsupportedAuthentication:
      "Dieser Authentifizierungsheader wird von der Agent-Laufzeit nicht unterstützt",
  },
};
