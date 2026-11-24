export const autopilotActionsCopy = {
  newOrder: "Neuer Auftrag",
  startOrder: "Auftrag starten",
  project: "Projekt",
  chooseProject: "Projekt auswählen",
  noProjects: "Lege unter Projekte ein Git-Projekt an, um einen Auftrag zu erstellen.",
  title: "Auftragstitel",
  brief: "Auftragsbeschreibung",
  briefLimit: "Kürze die Auftragsbeschreibung auf höchstens 65.536 UTF-8-Bytes.",
  noCli: "Installiere eine Coding-CLI, um den Autopiloten zu starten.",
  permissions: "Auftragsberechtigungen",
  editPolicy: "Berechtigungen bearbeiten",
  allowMerge: "Autopilot darf Pull Requests mergen",
  mergeHint:
    "Der Autopilot darf die Pull Requests dieses Auftrags nach den vorgeschriebenen Repository-Prüfungen mergen.",
  implementationAuthorized: "Umsetzung erlauben",
  implementationHint:
    "Der Autopilot darf für die hier beschriebenen Arbeiten Pipelines starten.",
  granted: "Erlaubt",
  withheld: "Aus",
  pause: "Auftrag pausieren",
  resume: "Auftrag fortsetzen",
  recover: "Session wiederherstellen",
  recoveryHint:
    "Der Autopilot setzt am gespeicherten Zwischenstand an, verwendet nach Möglichkeit den bisherigen Chat und öffnet bei Bedarf eine neue Session.",
  changeAccess: "Andere CLI oder anderen Zugang auswählen",
  remove: "Auftrag entfernen",
  finishRemoval: "Entfernen abschließen",
  removeTitle: (title) => `„${title}“ entfernen?`,
  removeEffect:
    "Auftragsbeschreibung, Fortschritt, Autopilot-Session sowie deren Branch und Worktree werden entfernt. Pipeline-Läufe und Pull-Request-Verlauf bleiben verfügbar.",
  stopFirst:
    "Stoppe vor dem Entfernen die Autopilot-Session. Der Worktree muss sauber sein und seine Commits müssen im Basisbranch enthalten sein.",
  typeTitle: "Zum Bestätigen den Auftragstitel eingeben",
  openReserved: "Reservierten Auftrag öffnen",
};
