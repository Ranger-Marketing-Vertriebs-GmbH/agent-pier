/** German messages of the ticket sources (GitHub issues, Plane work items). */
export const tickets = Object.freeze({
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
