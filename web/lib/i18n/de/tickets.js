// Ticketquellen: die Plane-Zugänge unter Zugänge und die Texte der Codes, mit denen
// eine Ticketquelle oder ein Ticketstart antwortet.
export const planeConnectionsCopy = {
  title: "Ticketquellen",
  description:
    "Plane-Zugänge für den Tickets-Tab eines Projekts. GitHub-Issues nutzen die GitHub-Zugänge.",
  list: "Plane-Zugänge",
  add: "Plane-Zugang hinzufügen",
  edit: "Plane-Zugang bearbeiten",
  remove: "Löschen",
  editRow: "Bearbeiten",
  rowActions: (name) => `Aktionen für ${name}`,
  removeTitle: (name) => `Plane-Zugang „${name}“ löschen?`,
  removeConfirm: (name) =>
    `AgentPier vergisst den Zugang „${name}“ und seinen API-Schlüssel. Projekte, die ihn noch nutzen, müssen vorher getrennt werden.`,
  loadFailed: "Die Plane-Zugänge konnten nicht geladen werden.",
  name: "Name",
  namePlaceholder: "Plane bei der Arbeit",
  apiUrl: "API-Adresse",
  apiUrlHelp:
    "https://api.plane.so für Plane Cloud oder die Adresse deines eigenen Plane. Nur https:// (http:// nur für localhost).",
  workspace: "Workspace-Kürzel",
  workspaceHelp: "Der Teil nach der Adresse in deiner Plane-URL, zum Beispiel mein-team.",
  apiKey: "API-Schlüssel",
  apiKeyKeep: "Gespeichert. Leer lassen, um den Schlüssel zu behalten.",
  apiKeyPlaceholder: "Plane-API-Schlüssel",
  apiKeyHelp:
    "Erstelle ihn in Plane unter Profileinstellungen › Persönliche Zugriffstoken. Er wird auf diesem Rechner gespeichert und nie wieder angezeigt.",
};

// Nach `TicketSourceError`-Code: der Listenfehler einer Quelle und ein gescheitertes
// Zurückschreiben. Die Startablehnungen kommen als übersetzte Servermeldungen.
export const ticketErrorCopy = {
  unauthorized:
    "Die Ticketquelle hat die Zugangsdaten abgelehnt. Bitte prüfe den API-Schlüssel.",
  forbidden: "Der API-Schlüssel hat dafür keine Berechtigung.",
  notFound: "Die Ticketquelle hat die Anfrage nicht gefunden.",
  rateLimited:
    "Die Ticketquelle begrenzt gerade die Anfragen. Versuche es später erneut.",
  unavailable: "Die Ticketquelle ist gerade nicht verfügbar.",
  unreachable: "Die Ticketquelle ist nicht erreichbar.",
  invalidResponse: "Die Ticketquelle hat eine unerwartete Antwort geliefert.",
  notConnected: "Die Ticketquelle ist für dieses Projekt nicht verbunden.",
};

// Der Tickets-Tab eines Projekts: seine Quellen, die Ticketliste und die Zeilenaktionen.
export const projectTicketsCopy = {
  sources: "Ticketquellen",
  github: "GitHub",
  plane: "Plane",
  githubConnected: (repo, credential, label) =>
    `${repo} · ${credential} · markiert gestartete Issues mit „${label}“`,
  githubNotConnected:
    "Nicht verbunden. Issues brauchen ein GitHub-Remote und einen GitHub-Zugang für dessen Host.",
  planeConnected: (identifier, name, connection) =>
    [`${identifier} · ${name}`, connection].filter(Boolean).join(" · "),
  planeUnavailable: (identifier, name) =>
    `${identifier} · ${name} · der Plane-Zugang ist nicht verfügbar`,
  planeNotConnected: "Plane-Projekt verbinden",
  edit: "Bearbeiten",
  editTitle: "Ticketquellen bearbeiten",
  connection: "Plane-Zugang",
  chooseConnection: "Zugang wählen",
  noConnections: "Es gibt noch keinen Plane-Zugang.",
  planeProject: "Plane-Projekt",
  choosePlaneProject: "Projekt wählen",
  loadingPlaneProjects: "Plane-Projekte werden geladen …",
  startedState: "Status „In Arbeit“",
  startedStateAuto: "Erster gestarteter Status in Plane",
  startedStateHelp: "Der Status, in den ein Work Item beim Start wechselt.",
  githubLabel: "GitHub-Label für gestartete Issues",
  githubLabelHelp:
    "Wird beim Start an ein Issue gehängt. GitHub legt ein fehlendes Label an.",
  disconnect: "Plane-Projekt trennen",
  label: "Label",
  allLabels: "Alle Labels",
  searchLabels: "Labels durchsuchen",
  source: "Quelle",
  allSources: "Alle",
  unregistered:
    "Tickets gehören zu einem Projektordner. Füge den Ordner hinzu, um seine Tickets zu nutzen.",
  loading: "Tickets werden geladen …",
  loadFailed: "Die Ticketquellen dieses Projekts konnten nicht geladen werden.",
  sourceError: (source, message) => `${source}: ${message}`,
  list: "Tickets",
  noTickets: "Keine offenen Tickets.",
  noMatches: "Kein offenes Ticket hat dieses Label.",
  noSources: "Keine Ticketquelle verbunden",
  noSourcesBody:
    "Verbinde GitHub für die Issues dieses Repositorys oder ein Plane-Projekt für seine Work Items.",
  githubReference: "GitHub-Zugänge",
  githubReferenceSub: "Issues brauchen einen GitHub-Zugang für den Host des Repositorys.",
  planeReference: "Ticketquellen",
  planeReferenceSub: "Plane-Zugänge für Work Items.",
  started: "Gestartet",
  writeBackFailed: "Zurückschreiben fehlgeschlagen",
  writeBackDetail: (message) =>
    `Gestartet, aber nicht als in Arbeit markiert: ${message}`,
  rowActions: (key) => `Aktionen für ${key}`,
  startSession: "Session starten",
  startRun: "Pipeline-Lauf starten",
  openIn: (source) => `In ${source} öffnen`,
  openSession: "Session öffnen",
  openRun: "Pipeline-Lauf öffnen",
  againTitle: (key) => `${key} erneut starten?`,
  againBody:
    "Dieses Ticket wurde schon gestartet. Ein erneuter Start legt eine weitere Session oder einen weiteren Lauf an und markiert das Ticket noch einmal.",
  again: "Erneut starten",
};

// Der Session- und der Laufdialog, wenn sie ein Ticket starten.
export const ticketStartCopy = {
  sessionTitle: (key) => `${key} als Session starten`,
  runTitle: (key) => `${key} als Pipeline-Lauf starten`,
  sessionDescription: (title) =>
    `Die Session startet im Projektordner mit dem Ticket „${title}“ als Aufgabe.`,
  runDescription: (title) =>
    `Der Lauf startet im Projektordner mit dem Ticket „${title}“ als Aufgabe.`,
  again: "Erneut starten",
};
