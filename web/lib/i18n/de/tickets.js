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
  alreadyStarted:
    "Dieses Ticket wurde schon gestartet. Bestätige, um es erneut zu starten.",
  alreadyStarting: "Dieses Ticket wird gerade gestartet.",
  connectionInUse: "Ein Projekt nutzt diesen Zugang noch.",
};
