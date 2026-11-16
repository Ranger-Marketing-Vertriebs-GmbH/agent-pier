export const projectDeletion = {
  projectDeleting: "Dieses Projekt wird gerade gelöscht.",
  projectNotFound: "In diesem Ordner ist kein Projekt registriert.",
  sessionsUnreadable:
    "Die Session-Daten ließen sich nicht lesen, daher sind die Sessions des Projekts nicht bekannt. Versuche es erneut.",
  deleteStale:
    "Der Ordner oder die Projekte darin haben sich seit der Prüfung geändert. Prüfe erneut, bevor du löschst.",
  deleteName: "Gib den Namen des Projekts ein, um das Löschen zu bestätigen.",
  deleteBlocked:
    "In diesem Projekt läuft noch etwas oder nutzt seinen Ordner. Beende es und prüfe erneut.",
  folderReappeared:
    "Der Ordner ist wieder da. Prüfe erneut, um ihn samt Inhalt zu löschen.",
  abortedBlocked:
    "In diesem Projekt läuft noch etwas oder nutzt seinen Ordner, daher wurde nichts gelöscht. Der Zugriff der Agenten auf dieses Projekt wurde bereits entfernt; erteile ihn neu, wenn du das Projekt behältst.",
  abortedStale:
    "Der Ordner oder die Projekte darin haben sich geändert, daher wurde nichts gelöscht. Der Zugriff der Agenten auf dieses Projekt wurde bereits entfernt; erteile ihn neu, wenn du das Projekt behältst.",
  aborted:
    "Das Löschen wurde abgebrochen, bevor etwas gelöscht wurde. Der Zugriff der Agenten auf dieses Projekt wurde bereits entfernt; erteile ihn neu, wenn du das Projekt behältst.",
  notFailed: "Nur ein fehlgeschlagenes Löschen kann wiederholt werden.",
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
    symlink:
      "Dieser Pfad ist ein Link oder nicht als echter Pfad des Ordners geschrieben; nur der echte Ordner kann gelöscht werden.",
    notDirectory: "Dieser Pfad ist kein Ordner.",
    driveUnavailable:
      "Das Laufwerk dieses Ordners ist nicht verfügbar. Solange es fehlt, wird nichts gelöscht.",
    agentpierProcess:
      "Ein Prozess, den AgentPier braucht (sein Server, der Session-Server oder das Gateway der Agenten), nutzt diesen Ordner, daher kann er nicht gelöscht werden.",
    unreadable: "Der Ordner ließ sich nicht lesen. Versuche es erneut.",
  },
};
