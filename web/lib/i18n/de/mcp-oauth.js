/** OAuth logins of central MCP servers; en/mcp-oauth.js has identical keys. */
export const mcpOAuthCopy = {
  authLabel: "Anmeldung",
  auths: {
    headers: "Header (Token)",
    oauth: "OAuth",
  },
  oauthHint:
    "Melde dich nach dem Speichern mit „Anmelden“ in der Serverliste an. Der Anbieter muss die automatische Client-Registrierung unterstützen; sonst lege ein Token in den Headern ab.",
  oauthEditHint:
    "Wenn du Name oder Adresse änderst oder zu Headern wechselst, wird die aktuelle OAuth-Anmeldung entfernt.",
  advanced: "Erweitert",
  scopeLabel: "OAuth-Scope (optional)",
  scopeHint:
    "Durch Leerzeichen getrennte Scopes, nur wenn der Anbieter bestimmte verlangt.",
  switchTitle: "Zu OAuth wechseln?",
  switchWarning: (names) =>
    `OAuth nutzt keine Header. Beim Speichern werden die gespeicherten Header ${names} gelöscht; sie lassen sich nicht wiederherstellen.`,
  switchConfirm: "Header löschen und speichern",
  authDetail: "Anmeldung",
  scopeDetail: "Scope",
  statuses: {
    connected: "Verbunden",
    "login-required": "Anmeldung nötig",
    "login-pending": "Anmeldung läuft",
    "not-connected": "Nicht verbunden",
    "logout-pending": "Alte Anmeldung wird entfernt",
    unknown: "Status unbekannt",
  },
  expires: (time) => `Zugriff gültig bis ${time}; er wird automatisch erneuert.`,
  logoutPendingHint:
    "Die vorherige Anmeldung wird noch entfernt. Bis dahin ist der Server nicht aktiv; eine neue Anmeldung entfernt sie zuerst.",
  logoutDeferred:
    "Gespeichert. Die vorherige OAuth-Anmeldung ließ sich gerade nicht entfernen; AgentPier versucht es im Hintergrund erneut.",
  unknownHint:
    "Der Anmeldestatus lässt sich gerade nicht lesen, zum Beispiel solange die Agenten-Laufzeit nicht läuft.",
  statusLabel: (status) => `Anmeldestatus: ${status}`,
  login: "Anmelden",
  loginNamed: (name) => `Bei ${name} anmelden`,
  loggingIn: "Anmeldung wird geöffnet …",
  logout: "Abmelden",
  logoutNamed: (name) => `Von ${name} abmelden`,
  loggingOut: "Meldet ab …",
  loggedOut: (name) => `Von ${name} abgemeldet.`,
  alreadyConnected: (name) => `${name} ist bereits verbunden.`,
  invalidAuthorizationUrl: "Die Anmeldeadresse ist ungültig.",
  originBlocked:
    "Von der Adresse, mit der du AgentPier geöffnet hast, lassen sich keine OAuth-Anmeldungen starten. Server mit Headern sind nicht betroffen.",
  connected: (name) =>
    `Bei ${name} angemeldet. Zugewiesene Agenten können die Werkzeuge ab ihrem nächsten Zug nutzen.`,
  failed: (name) => `Die Anmeldung bei ${name} ist fehlgeschlagen.`,
  failedUnnamed: "Die OAuth-Anmeldung ist fehlgeschlagen.",
  thisServer: "dem Server",
  dismiss: "Ausblenden",
  reasons: {
    access_denied: "Der Zugriff wurde beim Anbieter abgelehnt.",
    invalid_request: "Der Anbieter hat die Anmeldeanfrage abgelehnt.",
    invalid_scope:
      "Der Anbieter hat den angefragten Scope abgelehnt. Prüfe den Scope in den erweiterten Einstellungen des Servers.",
    unauthorized_client: "Der Anbieter erlaubt diesem Client keine Anmeldung.",
    unsupported_response_type: "Der Anbieter unterstützt diese Art der Anmeldung nicht.",
    server_error:
      "Der Anbieter hat einen internen Fehler gemeldet. Versuche es später erneut.",
    temporarily_unavailable:
      "Der Anbieter ist vorübergehend nicht erreichbar. Versuche es später erneut.",
    "provider-error": "Der Anbieter hat einen Fehler gemeldet.",
    "code-missing":
      "Der Anbieter hat keinen Anmeldecode geliefert. Starte die Anmeldung erneut.",
    "invalid-code":
      "Der Anbieter hat einen ungültigen Anmeldecode geliefert. Starte die Anmeldung erneut.",
    "invalid-name": "Dieser Servername lässt sich für keine Anmeldung nutzen.",
    "url-missing": "OpenClaw hat keine Anmeldeadresse geliefert. Bitte erneut versuchen.",
    "cli-timeout":
      "Der Abschluss der Anmeldung hat zu lange gedauert. Bitte erneut versuchen.",
    "no-dynamic-registration":
      "Dieser Anbieter unterstützt keine automatische Client-Registrierung. Nutze stattdessen ein Token in den Headern.",
    "redirect-rejected": (redirect) =>
      `Der Anbieter hat die Weiterleitungsadresse ${redirect} abgelehnt.`,
    "session-missing":
      "Die Anmeldesitzung ist nicht mehr gültig. Starte die Anmeldung erneut.",
    "runtime-unavailable": "Die Agenten-Laufzeit ist nicht verfügbar.",
    "server-unknown":
      "Der Server ist noch nicht aktiv. Weise ihn einem Agenten zu und warte, bis die Agenten-Laufzeit läuft.",
    "cli-failed":
      "Der Abschluss der Anmeldung ist fehlgeschlagen. Bitte erneut versuchen.",
    unavailable:
      "AgentPier konnte die Anmeldung gerade nicht abschließen, zum Beispiel während einer Sicherung oder Wiederherstellung. Starte die Anmeldung erneut.",
    unknown: "Die Anmeldung ließ sich nicht abschließen. Bitte erneut versuchen.",
  },
  agentLoginHint: "Melde OAuth-Server unter Accounts › MCP-Server an.",
};
