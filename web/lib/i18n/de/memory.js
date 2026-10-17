export const memoryCopy = {
  savedByAssistant: "Von einem Agenten gespeichert",
  discoveryError:
    "Memory-Hooks konnten nicht konfiguriert werden. Prüfe die Hook-Konfiguration der Sitzung und versuche es erneut.",
  addProject: "Projekt hinzufügen",
  directory: "Projektordner",
  notRegistered:
    "Für dieses Projekt ist noch kein Wissen gespeichert. Registriere den Ordner, um Einträge anzulegen.",
  tabHint:
    "Git-Worktrees teilen das Repository-Wissen. Andere Projekte bleiben getrennt. Einträge sind geteilte Notizen, keine automatisch geprüften Anweisungen.",
  newEntry: "Neuer Eintrag",
  editEntry: "Eintrag bearbeiten",
  entryTitle: "Titel",
  content: "Inhalt",
  search: "Wissen suchen",
  empty: "Noch keine Einträge.",
  active: "Aktiv",
  archived: "Archiv",
  countsUnavailable: "Die Anzahl der Einträge konnte nicht geladen werden.",
  archive: (title) => `Archivieren: ${title}`,
  restore: (title) => `Wiederherstellen: ${title}`,
  edit: (title) => `Bearbeiten: ${title}`,
  history: (title) => `Versionen: ${title}`,
  forget: (title) => `Endgültig vergessen: ${title}`,
  forgetAction: "Endgültig vergessen",
  forgetTitle: "Eintrag endgültig vergessen",
  forgetWarning:
    "Der Eintrag wird mit allen Versionen aus der Wissensdatenbank gelöscht. Das lässt sich nicht rückgängig machen. Derselbe Titel und Inhalt wird in diesem Projekt nicht erneut gespeichert; ein anderer Eintrag, der denselben Text bereits enthält, bleibt bestehen.",
  forgetLimit:
    "Gesperrt wird nur identischer Text: Dasselbe Geheimnis in anderem Text lässt sich weiterhin speichern.",
  forgetArchives:
    "Vorhandene Sicherungsarchive unter Einstellungen → Betrieb → Sicherungen enthalten den Inhalt weiterhin. Lösche oder behandle sie von Hand.",
  forgetReason: "Begründung (optional; nie das Geheimnis selbst eintragen)",
  forgetRemoveBackups: (count) =>
    `Auch ${count === 1 ? "die Migrationssicherung" : `die ${count} Migrationssicherungen`} der Wissensdatenbank (memory.sqlite.*) auf diesem Rechner löschen`,
  forgetIncomplete:
    "Der Eintrag ist vergessen, aber die Dateien der Wissensdatenbank sind noch nicht vollständig bereinigt. AgentPier versucht es beim nächsten Start und beim nächsten Vergessen erneut.",
  forgetRecordsIncomplete:
    "Agenten-Aufzeichnungen enthalten den Text noch. AgentPier versucht ihn beim nächsten Start und beim nächsten Vergessen erneut zu entfernen.",
  historyTitle: "Versionsverlauf",
  version: (revision) => `Version ${revision}`,
  latest: "Aktuellen Stand laden",
  savedByUser: "Von dir gespeichert",
  savedByAgent: (tool) => `Von ${tool} gespeichert`,
  reference: "Einträge sind geteilte Notizen, keine automatisch geprüften Anweisungen.",
  entries: "Wissenseinträge",
};
