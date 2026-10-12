export const mcpCliCopy = {
  legend: "Coding-CLIs",
  hint: "AgentPier trägt den Server in die eigene Konfiguration jeder gewählten CLI ein, für alle ihre Accounts. So funktioniert er auch, wenn du die CLI im Terminal startest. Laufende Sitzungen sehen eine Änderung nach einem Neustart.",
  unsupported: {
    transport: "Codex unterstützt keine SSE-Server.",
    cwd: "Claude Code kann einen lokalen Befehl nicht in einem Arbeitsverzeichnis starten; Codex und OpenCode können das.",
  },
  removedOnSave: (cli, name) => `Beim Speichern wird ${name} aus ${cli} entfernt.`,
  notGiven: (cli) => `${cli} bekommt diesen Server nicht.`,
  statuses: {
    written: "eingetragen",
    pending: "wird beim nächsten Speichern oder Sitzungsstart eingetragen",
    conflict: "in der CLI von Hand geändert",
    "name-taken": "der Name ist in der CLI schon von einem anderen Eintrag belegt",
    error: "konnte nicht eingetragen werden",
  },
  reasons: {
    unreadable: "ihre Konfigurationsdatei lässt sich nicht lesen",
    "too-large": "ihre Konfigurationsdatei ist größer als 64 MiB und bleibt unverändert",
    duplicate: "der Name steht in mehr als einer ihrer Konfigurationsdateien",
    changed: "ihre Konfigurationsdatei änderte sich laufend; bitte erneut speichern",
    layout:
      "ihre Konfigurationsdatei lässt sich nicht an Ort und Stelle ändern, ohne andere Einträge zu verändern",
    "write-failed": "ihre Konfigurationsdatei lässt sich nicht schreiben",
    failed:
      "ihre MCP-Server ließen sich nicht vorbereiten; AgentPier versucht es beim nächsten Sitzungsstart erneut",
    transport: "sie unterstützt diese Verbindungsart nicht",
    cwd: "sie kann kein Arbeitsverzeichnis verwenden",
    invalid: "sie kann den Server so nicht übernehmen",
  },
  statusLine: (cli, status) => `${cli}: ${status}`,
  errorWithReason: (reason) => `konnte nicht eingetragen werden: ${reason}`,
  overwrite: "AgentPiers Version schreiben",
  overwriteFor: (cli, name) => `AgentPiers Version schreiben: ${name} in ${cli}`,
  adoptChange: "Änderung übernehmen",
  adoptChangeFor: (cli, name) => `Änderung übernehmen: ${name} aus ${cli}`,
  adopt: "Übernehmen",
  adoptFor: (cli, name) => `${name} aus ${cli} übernehmen`,
  oauthConnected: (cli) => `In ${cli} angemeldet`,
  // Codex status is read from the owner's own profile only (~/.codex).
  oauthConnectedCodex: "In deinem Codex-Profil (~/.codex) angemeldet",
  oauthLoginCodex: (command) => `Einmal in deinem Codex-Profil anmelden: ${command}`,
  oauthUnknownCodex: (command) =>
    `Falls dein Codex-Profil eine Anmeldung verlangt: ${command} ausführen`,
  oauthCodexAccounts: (command) =>
    `Von AgentPier verwaltete Codex-Accounts haben eigene MCP-Anmeldungen: ${command} in einer Sitzung des jeweiligen Accounts ausführen.`,
  oauthLogin: (cli, command) => `Einmal in ${cli} anmelden: ${command} ausführen`,
  oauthUnknown: (cli, command) =>
    `Falls ${cli} eine Anmeldung verlangt: ${command} ausführen`,
  oauthLoginSession: (cli, command) => `Einmal anmelden: in ${cli} ${command} aufrufen`,
  oauthUnknownSession: (cli, command) =>
    `Falls ${cli} eine Anmeldung verlangt: in ${cli} ${command} aufrufen`,
  agentsUsing: (names) => `Agenten: ${names}`,
  clisUsing: (names) => `CLIs: ${names}`,
  unused: "Noch nicht in Verwendung",
  restartNote: "Laufende Sitzungen sehen Änderungen nach einem Neustart.",
  foundTitle: "In den CLIs gefunden",
  foundHint:
    "Einträge, die du selbst in einer CLI angelegt hast. AgentPier lässt sie unverändert, bis du sie übernimmst. Werte werden nie angezeigt.",
  foundNone: "Sonst nichts in den CLIs gefunden.",
  foundIn: (clis) => `in ${clis}`,
  valueNames: (names) => `Werte: ${names}`,
  proposedName: "Name in AgentPier",
  adoptNamed: (name) => `${name} übernehmen`,
  savedAs: (path) => `wird gespeichert als ${path}`,
  commandMissing: "Befehl auf diesem Computer nicht gefunden.",
  adoptAll: "Alle übernehmen",
  notAdoptable: {
    "unsupported-fields":
      "Nutzt Einstellungen, die AgentPier nicht verwaltet; bleibt in der CLI.",
    invalid: "Lässt sich nicht lesen; bleibt in der CLI.",
    duplicate: "Steht in mehr als einer Konfigurationsdatei; bleibt in der CLI.",
  },
  adoptFailed: (name, error) => `${name}: ${error}`,
  extensionsMoved:
    "MCP-Server werden zentral unter Accounts → MCP-Server verwaltet. Dort wählst du, welche Coding-CLIs einen Server bekommen; AgentPier trägt ihn in die Konfiguration dieser CLI ein.",
  openCentralList: "MCP-Server öffnen",
  stdioCliTitle: "Coding-CLIs einen lokalen Befehl geben?",
  stdioCliWarning:
    "Ein stdio-Server führt diesen Befehl mit deinen Rechten aus. Jede Sitzung der gewählten CLIs startet ihn, auch wenn du die CLI im Terminal startest. Füge nur Befehle hinzu, denen du vertraust.",
  stdioCliConfirm: "Bestätigen und speichern",
};
