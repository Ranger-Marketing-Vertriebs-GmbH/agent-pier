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
};
