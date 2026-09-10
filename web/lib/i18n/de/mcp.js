export const mcpCopy = {
  sessionTools: "AgentPier-Werkzeuge",
  sessionToolsSummary:
    "Pipelines aus dieser Sitzung steuern – ohne zusätzliche Anmeldung.",
  sessionToolsHint:
    "Gilt für diese Sitzung, höchstens zwölf Stunden. Neuladen erneuert eine aktive Freigabe. Sichtbar sind nur selbst gestartete Läufe; sie laufen nach Ende der Sitzung weiter. Pipeline-Sitzungen erhalten diesen Zugang nicht.",
  currentProject: "Arbeitsverzeichnis dieser Sitzung als Projekt freigeben",
  sessionResourcesHint:
    "Wähle die Accounts und gegebenenfalls Anbieter-Verbindungen der gewünschten Pipeline. Für einen PR-Schritt sind zusätzlich Veröffentlichungsrechte nötig.",

  title: "MCP & Zugriffe",
  introduction:
    "Verbinde deine Coding-CLI mit AgentPier und lege fest, welche Projekte und Aktionen sie nutzen darf.",
  setup: "Coding-CLI verbinden",
  endpoint: "HTTPS-MCP-Adresse",
  localEndpoint: "Lokale MCP-Adresse",
  localPrerequisites:
    "Diese HTTP-Adresse funktioniert nur auf dem Rechner, auf dem AgentPier läuft. CLI und Browserfreigabe dort öffnen. Für eine CLI auf einem anderen Rechner privaten HTTPS-Fernzugriff über Tailscale einrichten.",
  prerequisites:
    "Dein Rechner braucht eine aktive Tailscale-Verbindung zum selben Tailnet. Öffne die Browserfreigabe als Eigentümer von AgentPier auf dem Rechner, auf dem die CLI läuft.",
  unavailable: "HTTPS-Verbindung einrichten",
  unavailableHelp:
    "Für Remote-MCP muss eine gültige HTTPS-Adresse über Tailscale Serve eingerichtet und als remoteUrl in AgentPier konfiguriert sein. Lokales HTTP ist ausschließlich über Loopback mit festem Server-Port möglich. Bei ungültiger Fernzugriffskonfiguration wird nicht automatisch auf HTTP gewechselt.",
  connectionHint:
    "Die Anmeldung öffnet den Browser. Prüfe dort Client, Rechte und Ressourcen. Für neue Läufe zusätzlich „Läufe starten“ und die benötigten Ressourcen auswählen; zunächst sind nur Leserechte vorausgewählt. Bestätige die Auswahl und kehre zur CLI zurück.",
  codexHint:
    "Auf dem CLI-Rechner ausführen. „Hinzufügen“ startet bereits die Browseranmeldung. Den zusätzlichen Login nur verwenden, wenn die Anmeldung wiederholt werden muss; dabei wird DCR ausdrücklich ausgewählt.",
  claudeHint:
    "Nach dem Hinzufügen Claude Code öffnen und /mcp ausführen. AgentPier wählen und die Anmeldung im Browser starten.",
  opencodeHint:
    "Diesen Eintrag in die vorhandene opencode.json unter mcp übernehmen; weitere Einstellungen behalten. Die Konfiguration verwendet das OpenCode-1.x-Format.",
  opencodeRemove: "Danach den Eintrag mcp.agentpier aus der opencode.json entfernen.",
  revokeHint:
    "Das Entfernen in der CLI beendet die Freigabe auf dem Server nicht automatisch. Widerrufe den Zugriff zusätzlich unten.",
  docs: "Offizielle Anleitung",
  add: "Hinzufügen",
  login: "Anmelden",
  retryLogin: "Anmeldung bei Bedarf wiederholen",
  check: "Verbindung prüfen",
  remove: "Entfernen",
  copy: (label) => `${label} kopieren`,
  copied: "Kopiert",
  copyFailed: "Kopieren fehlgeschlagen. Markiere den Text und kopiere ihn manuell.",
  loading: "MCP-Zugriffe werden geladen …",
  retry: "Erneut versuchen",
  grants: "Verbundene Clients",
  noGrants: "Noch keine Clients freigegeben.",
  created: "Freigegeben am",
  expires: "Gültig bis",
  lastUsed: "Zuletzt verwendet",
  neverUsed: "Noch nicht verwendet",
  active: "Aktiv",
  expired: "Abgelaufen",
  revoked: "Widerrufen",
  revoke: "Zugriff widerrufen",
  confirmRevoke: "Widerruf bestätigen",
  revokeWarning:
    "Dieser Client verliert sofort den Zugriff. Für eine neue Verbindung ist eine neue Browserfreigabe nötig.",
  cancel: "Abbrechen",
  previous: "Vorherige Zugriffe",
  next: "Nächste Zugriffe",
  page: (page, total) => `Seite ${page} · ${total} Zugriffe`,
  scopes: "Berechtigungen",
  resources: "Erlaubte Ressourcen",
  resourceHelp:
    "Wähle die einzelnen Ressourcen aus. Ohne Auswahl bleibt die jeweilige Ressourcengruppe gesperrt. Für Läufe mit einem zentralen Anbieter werden sowohl das Quellkonto als auch die Anbieterverbindung benötigt.",
  projects: "Projekte",
  accounts: "Quellkonten",
  connections: "Anbieterverbindungen",
  none: "Keine",
  consent: "Zugriff freigeben",
  consentHelp:
    "Dieser Client möchte sich mit AgentPier verbinden. Sein Name wurde vom Client angegeben. Prüfe die angeforderten Rechte vor der Freigabe.",
  clientId: "Client-ID",
  callback: "Rückkehr zur CLI",
  approve: "Auswahl freigeben",
  deny: "Ablehnen",
  returning: "Freigabe gespeichert. Rückkehr zur CLI …",
  noScopes: "Wähle mindestens eine Berechtigung aus.",
  expiredRequest: "Diese Anfrage ist abgelaufen. Starte die Anmeldung in der CLI erneut.",
  invalidRedirect:
    "Die Rückkehr zur CLI konnte nicht sicher geöffnet werden. Starte die Anmeldung erneut.",
  publishingHelp:
    "Erlaubt Veröffentlichungsschritte in Pipelines, etwa Push oder Pull Requests. Nur aktivieren, wenn dieser Client solche Änderungen ausführen soll.",
  scopeLabels: {
    "catalog:read": "Katalog lesen",
    "definitions:write": "Profile und Pipelines bearbeiten",
    "runs:read": "Läufe und Ergebnisse lesen",
    "runs:start": "Läufe starten",
    "runs:cancel": "Eigene Läufe abbrechen",
    "runs:publish": "Veröffentlichen",
  },
};
