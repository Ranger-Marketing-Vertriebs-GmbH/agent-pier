export const projectDeletionCopy = {
  deleteAction: "Projekt löschen …",
  removeAction: "Aus AgentPier entfernen …",
  deleteTitle: (name) => `Projekt „${name}“ löschen?`,
  removeTitle: (name) => `Projekt „${name}“ aus AgentPier entfernen?`,
  deleteBody: (path) =>
    `Der Ordner ${path} und alles darin wird endgültig von der Festplatte gelöscht, zusammen mit allem, was AgentPier über das Projekt speichert. Das lässt sich nicht rückgängig machen.`,
  removeBody: (path) =>
    `Der Ordner ${path} existiert nicht mehr. Nur die Daten, die AgentPier über das Projekt speichert, werden entfernt. Das lässt sich nicht rückgängig machen.`,
  typeName: (name) => `Gib „${name}“ ein, um zu bestätigen`,
  confirmDelete: "Endgültig löschen",
  confirmRemove: "Aus AgentPier entfernen",
  loading: "Prüfe den Ordner …",
  blockersTitle: "Läuft noch in diesem Projekt",
  blockersNote: "Das Projekt lässt sich löschen, sobald nichts mehr darin läuft.",
  stopSessions: "Sessions beenden",
  blockerRun: (name) => `Pipeline-Lauf ${name}`,
  blockerQueued: (count) =>
    count === 1
      ? "1 Pipeline-Lauf in der Warteschlange"
      : `${count} Pipeline-Läufe in der Warteschlange`,
  blockerRebuild: (name) => `Craft-Rebuild ${name}`,
  processesTitle: "Andere Prozesse im Ordner",
  processLabel: (name, pid) => `${name} (PID ${pid})`,
  knownSession: "Session in AgentPier",
  knownAgentCommand: "Befehl eines Agenten",
  endProcesses: "Ausgewählte beenden",
  processOther:
    "Prozess eines anderen Systembenutzers; AgentPier kann ihn nicht beenden.",
  processProtected: "AgentPier braucht diesen Prozess; er kann nicht beendet werden.",
  scanTimeout: "Die Prozesse im Ordner ließen sich nicht prüfen.",
  rescan: "Erneut prüfen",
  gitTitle: "Ungesicherte Arbeit geht verloren",
  gitChanges: (count) =>
    count === 1 ? "1 nicht committete Änderung" : `${count} nicht committete Änderungen`,
  gitUnpushed: (count) =>
    count === 1
      ? "1 Commit, den kein Remote hat"
      : `${count} Commits, die kein Remote hat`,
  gitUnchecked: (path) => `${path} ließ sich nicht prüfen.`,
  linkedWorktree: (path) =>
    `Der verknüpfte Worktree ${path} liegt außerhalb des Ordners und bleibt erhalten; entferne ihn danach von Hand.`,
  nestedTitle: "Diese Projekte im Ordner werden mitgelöscht",
  accessTitle: "Zugriff",
  accessAgents: (names) => `Agenten: ${names}`,
  accessUsers: (names) => `Benutzer dieser Agenten: ${names}`,
  accessNote: "Ihr Zugriff auf das Projekt endet mit ihm.",
  folderMissing: "Ordner fehlt",
  driveUnavailable: "Laufwerk nicht verfügbar",
  deleting: "Wird gelöscht …",
  deletionFailed: "Löschen fehlgeschlagen — Wiederholen",
  retry: "Wiederholen",
  filterLabel: "Projekte anzeigen",
  missingFilter: (count) => `Ordner fehlt (${count})`,
  allFilter: "Alle",
  refusals: {
    root: "Die Wurzel des Dateisystems kann nicht gelöscht werden.",
    home: "Dein Benutzerordner kann nicht gelöscht werden.",
    homeParent:
      "Ein Ordner, der deinen Benutzerordner enthält, kann nicht gelöscht werden.",
    homeChild:
      "Ein Ordner direkt in deinem Benutzerordner (etwa Dokumente oder Projects) kann nicht gelöscht werden.",
    agentpier:
      "Dieser Ordner enthält AgentPier selbst oder seine Daten oder liegt darin und kann nicht gelöscht werden.",
    mountPoint:
      "Dieser Ordner ist ein eingebundenes Laufwerk und kann nicht gelöscht werden.",
    containsMount:
      "In diesem Ordner ist ein Laufwerk eingebunden. Wirf es zuerst aus; AgentPier löscht nie in ein eingebundenes Laufwerk hinein.",
    mountsUnreadable:
      "Die Liste der eingebundenen Laufwerke ließ sich nicht lesen, daher kann AgentPier ein Laufwerk in diesem Ordner nicht ausschließen. Versuche es erneut.",
    symlink:
      "Dieser Pfad ist ein Link oder nicht als echter Pfad des Ordners geschrieben; nur der echte Ordner kann gelöscht werden.",
    notDirectory: "Dieser Pfad ist kein Ordner.",
    driveUnavailable:
      "Das Laufwerk dieses Ordners ist nicht verfügbar. Solange es fehlt, wird nichts gelöscht.",
    agentpierProcess:
      "Ein Prozess, den AgentPier braucht (sein Server, der Session-Server oder das Gateway der Agenten), nutzt diesen Ordner, daher kann er nicht gelöscht werden.",
    unreadable: "Der Ordner ließ sich nicht lesen. Prüfe erneut.",
  },
  failures: {
    EACCES:
      "AgentPier darf einige Dateien im Ordner nicht löschen. Ändere ihre Berechtigungen und wiederhole dann.",
    PROJECT_DATA_LEFT:
      "Der Ordner ist gelöscht, aber einige Daten von AgentPier über das Projekt sind übrig. Wiederhole, um sie zu entfernen.",
    PROJECT_AGENTS_OFF:
      "Der Ordner ist gelöscht. Der Zugriff der Agenten auf das Projekt wird entfernt, sobald die Agenten wieder laufen.",
    PROJECT_FOLDER_CHANGED:
      "Der Ordner wurde nach der Prüfung ersetzt und deshalb nicht gelöscht.",
    PROJECT_DELETE_REFUSED:
      "AgentPier hat das Löschen dieses Ordners verweigert, weil er ein geschützter oder verlinkter Pfad ist oder darin ein Laufwerk eingebunden ist.",
    PROJECT_DELETE_BLOCKED:
      "Im Projekt läuft wieder etwas oder nutzt seinen Ordner. Beende es und wiederhole dann.",
    PROJECT_FOLDER_REAPPEARED:
      "Der Ordner ist wieder da. Lösche ihn samt Inhalt mit „Projekt löschen …“.",
    PROJECT_DELETE_FAILED:
      "Das Löschen wurde nicht fertig. Wiederhole, um es fortzusetzen.",
  },
};
