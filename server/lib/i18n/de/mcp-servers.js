export const mcpServers = {
  invalidName:
    "Bitte einen Servernamen mit 1 bis 30 Zeichen aus Buchstaben, Ziffern, Unterstrich oder Bindestrich eingeben; das erste Zeichen muss ein Buchstabe sein.",
  nameTaken: "Dieser Servername ist bereits vergeben.",
  invalidTransport: "Bitte HTTP, SSE oder stdio als Verbindung wählen.",
  transportLocked: "Die Verbindungsart eines Servers lässt sich nicht ändern.",
  invalidCwd: "Bitte ein absolutes Arbeitsverzeichnis angeben.",
  commandNotFound:
    "Der Befehl wurde nicht gefunden oder ist nicht ausführbar. Bitte einen installierten Befehl oder einen absoluten Pfad angeben.",
  invalidTarget: "Dieses Ziel unterstützt keine MCP-Server.",
  invalidRequest: "Ungültige Anfrage für MCP-Server.",
  notFound: "MCP-Server nicht gefunden.",
  conflict: "Der MCP-Server wurde inzwischen geändert. Bitte neu laden.",
  stdioConfirmationRequired:
    "Ein stdio-Server führt einen Befehl mit deinen Rechten und ohne Sandbox aus. Bitte bestätigen.",
  agentNotEligible:
    "Diesem Agenten lassen sich keine MCP-Server zuordnen: Temporäre Teammitglieder erhalten sie über die Teamfreigabe, archivierte Agenten gar nicht.",
  oauthNotOAuth: "Dieser Server meldet sich nicht mit OAuth an.",
  oauthNotCompiled:
    "Der Server ist noch nicht aktiv. Bitte ihn einem Agenten zuordnen und warten, bis die Assistenz läuft.",
  oauthPlainHttpRemote:
    "OAuth braucht HTTPS oder den AgentPier-Rechner selbst. Bitte AgentPier über Tailscale (HTTPS) oder direkt auf dem AgentPier-Rechner öffnen.",
  oauthLoopbackRedirect:
    "Die Anmeldung kehrt zur lokalen Adresse des AgentPier-Rechners zurück. Bitte AgentPier direkt auf diesem Rechner öffnen oder Tailscale (HTTPS) einrichten.",
  oauthStateInvalid:
    "Diese Anmeldung ist abgelaufen, wurde ersetzt oder ist unbekannt. Bitte die Anmeldung neu starten.",
  oauthNoDynamicRegistration:
    "Dieser Anbieter unterstützt keine automatische Client-Registrierung. Bitte stattdessen einen Token in den Headern verwenden.",
  oauthRedirectRejected: (redirect) =>
    `Der Anbieter hat die Rücksprungadresse ${redirect} abgelehnt.`,
  oauthSessionMissing:
    "Die Anmeldesitzung ist nicht mehr gültig. Bitte die Anmeldung neu starten.",
  oauthCliTimeout:
    "Die Anmeldung hat nicht rechtzeitig geantwortet. Bitte erneut versuchen.",
  oauthRuntimeUnavailable: "Die Assistenz-Laufzeit ist nicht verfügbar.",
  oauthLoginFailed: "Die OAuth-Anmeldung ist fehlgeschlagen. Bitte erneut versuchen.",
  oauthLogoutFailed:
    "Die OAuth-Anmeldung des Servers ließ sich nicht entfernen. Bitte erneut versuchen.",
};
