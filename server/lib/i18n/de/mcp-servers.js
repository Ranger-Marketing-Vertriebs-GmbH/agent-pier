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
  stdioTelegramSenders:
    "Agenten mit eigenem Telegram-Bot für andere Personen können keine stdio-Server nutzen: Diese führen Befehle auf diesem Rechner aus. Entfernte Server bleiben möglich; trenne zuerst den Bot, um einen stdio-Server zu nutzen.",
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
  oauthLogoutDeferred:
    "Gespeichert. Die bisherige OAuth-Anmeldung ließ sich gerade nicht entfernen; AgentPier versucht es im Hintergrund weiter. Bis dahin bleibt ein Server mit demselben Namen und derselben Adresse inaktiv.",
  oauthRateLimited:
    "Zu viele OAuth-Anmeldungen und -Abmeldungen. Bitte in einer Minute erneut versuchen.",
  oauthLogoutPending:
    "Die bisherige Anmeldung wird noch entfernt. Bis dahin ist der Server nicht aktiv.",
  cliNotConflict:
    "Dieser Eintrag in der CLI steht nicht mehr im Konflikt. Bitte neu laden.",
  cliFindChanged:
    "Der Eintrag in der CLI hat sich seit der Anzeige geändert. Bitte neu laden.",
  cliNotAdoptable:
    "AgentPier kann diesen Eintrag nicht übernehmen, ohne Einstellungen zu verlieren, die es nicht verwaltet.",
  cliFindEnvReferences:
    "Der Eintrag nutzt Verweise auf Umgebungsvariablen oder Dateien (${…}, {env:…}, {file:…}). Eine andere CLI oder ein Agent würde sie anders lesen; er bleibt deshalb in der CLI.",
  cliChangeEnvReferences:
    "Die Änderung nutzt Verweise auf Umgebungsvariablen oder Dateien (${…}, {env:…}, {file:…}). Eine andere CLI oder ein Agent würde sie anders lesen; sie lässt sich deshalb nicht übernehmen.",
  valueReference:
    "AgentPier speichert Werte wörtlich. Verweise wie ${…}, {env:…} oder {file:…} würden die CLIs jeweils anders auflösen und Agenten gar nicht; bitte den Wert selbst eintragen.",
  cliChangeNotAdoptable:
    "Die Änderung lässt sich nicht übernehmen: Die Verbindungsart weicht ab oder der Eintrag nutzt Einstellungen, die AgentPier nicht verwaltet.",
  cliTransportUnsupported:
    "Diese Coding-CLI unterstützt die Verbindungsart des Servers nicht.",
  cliCwdUnsupported:
    "Diese Coding-CLI kann einen lokalen Befehl nicht in einem Arbeitsverzeichnis starten. Bitte das Arbeitsverzeichnis entfernen oder nur Codex oder OpenCode wählen.",
  cliStatusConflict:
    "Der Eintrag wurde in der CLI von Hand geändert. AgentPiers Fassung schreiben oder die Änderung übernehmen.",
  cliStatusNameTaken:
    "Die CLI hat schon einen eigenen Eintrag mit diesem Namen. Übernehmen, um ihn AgentPier zu überlassen.",
  cliReasonUnreadable: "Die Konfiguration der CLI kann nicht gelesen werden.",
  cliReasonTooLarge:
    "Die Konfiguration der CLI ist größer als 64 MiB; AgentPier liest und ändert sie nicht.",
  cliReasonChanged:
    "Die Konfiguration der CLI wurde laufend geändert und konnte nicht geschrieben werden. Bitte später erneut versuchen.",
  cliReasonLayout:
    "Die Konfiguration der CLI lässt sich nicht gezielt bearbeiten, ohne andere Einträge zu verändern.",
  cliReasonWriteFailed: "Die Konfiguration der CLI kann nicht geschrieben werden.",
  cliReasonFailed:
    "Die MCP-Server dieser CLI konnten nicht vorbereitet werden. AgentPier versucht es beim nächsten Sitzungsstart erneut.",
  cliReasonInvalid: "Diese Coding-CLI kann den Server so nicht eintragen.",
  cliReasonDuplicate:
    "Die CLI führt diesen Namen mehrfach. Bitte einen der Einträge in der CLI entfernen.",
  cliReasonPackage: "Das Paket des Servers ist noch nicht installiert oder fehlt.",
  cliLoginNotBound:
    "Der Server ist Codex nicht zugeordnet. Bitte Codex unter den Coding-CLIs des Servers auswählen.",
  cliLoginAccountInvalid:
    "Anmelden lässt sich nur in einem von AgentPier verwalteten Codex-Konto. Im eigenen Codex-Profil bitte codex mcp login im Terminal ausführen.",
  cliLoginCodexMissing:
    "Für die Anmeldung muss Codex auf dem AgentPier-Rechner installiert sein.",
  cliLoginLimit:
    "Zu viele offene Codex-Anmeldungen. Bitte eine abschließen oder abbrechen und erneut versuchen.",
  cliLoginPrepareFailed:
    "Das Codex-Konto ließ sich nicht vorbereiten. Bitte erneut versuchen, sobald keine Plugin-Aktion mehr läuft.",
  cliLoginEnded:
    "Die Anmeldung wurde beendet, bevor Codex sie starten konnte (abgebrochen oder ersetzt).",
  cliLoginFailed: "Codex konnte die Anmeldung nicht starten. Bitte erneut versuchen.",
};
