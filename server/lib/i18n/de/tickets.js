/** German messages of the ticket sources (GitHub issues, Plane work items). */
export const tickets = Object.freeze({
  connectionNotFound: "Die Ticketquellen-Verbindung wurde nicht gefunden.",
  connectionInUse: "Die Verbindung wird noch von einem Projekt verwendet.",
  invalidBaseUrl:
    "Die Adresse der Ticketquelle muss mit https:// beginnen (http:// nur für localhost) und darf weder Zugangsdaten, Parameter noch Anker enthalten.",
  invalidWorkspace: "Der Workspace-Kürzel der Ticketquelle ist ungültig.",
  invalidToken: "Der Token der Ticketquelle ist ungültig.",
  tokenRequired: "Für die Ticketquelle ist ein Token erforderlich.",
  tokenRequiredForAddress:
    "Gib den API-Schlüssel erneut ein: Der gespeicherte Schlüssel bleibt bei der alten Adresse der Ticketquelle.",
  invalidLabel:
    "Das GitHub-Label muss 1 bis 50 Zeichen haben und darf kein Komma enthalten.",
  invalidLink: "Die Ticketquellen-Zuordnung des Projekts ist ungültig.",
  invalidStart: "Der Ticketstart ist ungültig.",
  startNotFound: "Der Ticketstart wurde nicht gefunden.",
  projectNotFound: "Das Projekt wurde nicht gefunden.",
  invalidFilter: "Der Ticketfilter ist ungültig.",
  codingCliRequired: "Ein Ticket kann nur mit einem Coding-CLI gestartet werden.",
  alreadyStarting: "Dieses Ticket wird gerade gestartet.",
  alreadyStarted:
    "Dieses Ticket wurde bereits gestartet. Zum erneuten Start bitte ausdrücklich bestätigen.",
  taskNotDelivered:
    "Die Aufgabe konnte der neuen Session nicht übergeben werden; die Session wurde beendet.",
  invalidSequence: "Die Ticketfolge ist ungültig.",
  invalidRule: "Die Ticketregel ist ungültig.",
  ruleNotFound: "Die Ticketregel wurde nicht gefunden.",
  tooManyRules: "Dieses Repository hat zu viele Ticketregeln.",
  ruleExists: "Für diese Quelle und dieses Label gibt es schon eine Regel.",
  sequenceFull: "Die Ticketwarteschlange dieses Repositorys ist voll.",
  ticketQueued: "Dieses Ticket ist bereits eingereiht.",
  itemNotFound: "Das eingereihte Ticket wurde nicht gefunden.",
  itemBusy: "Dieses Ticket wird gerade bearbeitet.",
  githubRequired: "Ticketfolgen brauchen ein GitHub-Repository für dieses Projekt.",
  worktreeLeftover:
    "Der Ordner des letzten Versuchs liegt noch unter .worktrees/ und ist nicht sauber oder auf einem anderen Branch. Bitte den Ordner prüfen und entfernen, dann erneut versuchen.",
  prUnreadable:
    "GitHub war nicht lesbar, deshalb kann AgentPier Auto-Merge oder die Merge-Queue für diesen Pull Request nicht abschalten. Bestätige, um trotzdem fortzufahren, und prüfe den Pull Request dann auf GitHub.",
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
