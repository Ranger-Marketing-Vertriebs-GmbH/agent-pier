/** German messages of the ticket sources (GitHub issues, Plane work items). */
export const tickets = Object.freeze({
  connectionNotFound: "Die Ticketquellen-Verbindung wurde nicht gefunden.",
  connectionInUse: "Die Verbindung wird noch von einem Projekt verwendet.",
  invalidBaseUrl:
    "Die Adresse der Ticketquelle muss mit https:// beginnen (http:// nur für localhost) und darf weder Zugangsdaten, Parameter noch Anker enthalten.",
  invalidWorkspace: "Der Workspace-Kürzel der Ticketquelle ist ungültig.",
  invalidToken: "Der Token der Ticketquelle ist ungültig.",
  tokenRequired: "Für die Ticketquelle ist ein Token erforderlich.",
  invalidLink: "Die Ticketquellen-Zuordnung des Projekts ist ungültig.",
  invalidStart: "Der Ticketstart ist ungültig.",
  startNotFound: "Der Ticketstart wurde nicht gefunden.",
  projectNotFound: "Das Projekt wurde nicht gefunden.",
  invalidFilter: "Der Ticketfilter ist ungültig.",
  codingCliRequired: "Ein Ticket kann nur mit einem Coding-CLI gestartet werden.",
  alreadyStarting: "Dieses Ticket wird gerade gestartet.",
  alreadyStarted:
    "Dieses Ticket wurde bereits gestartet. Zum erneuten Start bitte ausdrücklich bestätigen.",
  source: Object.freeze({
    unauthorized: "Die Ticketquelle hat den Zugang abgelehnt. Bitte den Token prüfen.",
    forbidden: "Der Token der Ticketquelle hat dafür keine Berechtigung.",
    notFound: "Die Ticketquelle hat die Anfrage nicht gefunden.",
    rateLimited:
      "Die Ticketquelle begrenzt gerade die Anfragen. Bitte später erneut versuchen.",
    unavailable: "Die Ticketquelle ist gerade nicht verfügbar.",
    unreachable: "Die Ticketquelle ist nicht erreichbar.",
    invalidResponse: "Die Ticketquelle hat eine unerwartete Antwort geliefert.",
    notConnected: "Die Ticketquelle ist für dieses Projekt nicht verbunden.",
  }),
});
