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
  // Vermittelte Anmeldungen in von AgentPier verwalteten Codex-Accounts.
  codexAccountsTitle: "Codex-Accounts",
  codexAccountsFor: (name) => `Codex-Accounts für ${name}`,
  codexAccountsHint:
    "Jeder von AgentPier verwaltete Codex-Account hat eine eigene Anmeldung. Neue Sitzungen des Accounts nutzen sie.",
  codexAccountsNone: "Noch keine von AgentPier verwalteten Codex-Accounts.",
  codexAccountStates: {
    connected: "angemeldet",
    "login-required": "Anmeldung nötig",
    unknown: "Status unbekannt",
    pending: "Anmeldung läuft",
    failed: "Anmeldung fehlgeschlagen",
  },
  codexAccountLine: (account, status) => `${account}: ${status}`,
  codexFailedLine: (account, reason) => `${account}: Anmeldung fehlgeschlagen. ${reason}`,
  codexLogin: "Anmelden",
  codexLoginFor: (account, name) => `Im Codex-Account ${account} bei ${name} anmelden`,
  codexLoggingIn: "Anmeldung wird geöffnet …",
  codexCancel: "Abbrechen",
  codexCancelFor: (account, name) =>
    `Anmeldung bei ${name} im Codex-Account ${account} abbrechen`,
  codexPendingHint:
    "Die Anmeldung im neuen Tab innerhalb von fünf Minuten abschließen; diese Liste aktualisiert sich selbst.",
  codexOpenLogin: "Anmeldeseite öffnen",
  codexOpenLoginFor: (account) => `Anmeldeseite für den Codex-Account ${account} öffnen`,
  codexHttpHint: (port) =>
    `Die Anmeldung braucht die HTTPS-Adresse von AgentPier (Tailscale) oder einen Browser auf dem AgentPier-Rechner selbst. AgentPier auf einem dieser Wege öffnen und dort anmelden, oder den Port per SSH weiterleiten (ssh -L ${port}:127.0.0.1:${port} <AgentPier-Rechner>) und http://127.0.0.1:${port} öffnen.`,
  codexReasons: {
    expired: "Sie wurde nicht innerhalb von fünf Minuten abgeschlossen.",
    "cli-failed": "Codex konnte sie nicht abschließen. Bitte erneut versuchen.",
  },
  codexConnected: (account, name) =>
    `Der Codex-Account ${account} ist bei ${name} angemeldet. Neue Sitzungen dieses Accounts können seine Werkzeuge nutzen.`,
  codexFailed: (account, name) =>
    `Die Anmeldung des Codex-Accounts ${account} bei ${name} ist fehlgeschlagen.`,
  codexConnectedUnnamed: (name) =>
    `Ein Codex-Account ist bei ${name} angemeldet. Neue Sitzungen dieses Accounts können seine Werkzeuge nutzen.`,
  codexFailedUnnamed: (name) =>
    `Die Anmeldung eines Codex-Accounts bei ${name} ist fehlgeschlagen.`,
  codexLoginAgain: "Erneut anmelden",
  codexLoginAgainFor: (account, name) =>
    `Im Codex-Account ${account} erneut bei ${name} anmelden`,
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
  foundLoading: "Suche in den CLIs …",
  adopted: (names) => `Übernommen: ${names}.`,
  envReferences: (names) =>
    `Nutzt Verweise auf Umgebungsvariablen oder Dateien (in ${names}); eine andere CLI oder ein Agent würde sie anders lesen, deshalb bleibt er in der CLI.`,
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
  stdioCliTitle: "Coding-CLIs einen lokalen Befehl geben?",
  stdioCliWarning:
    "Ein stdio-Server führt diesen Befehl mit deinen Rechten aus. Jede Sitzung der gewählten CLIs startet ihn, auch wenn du die CLI im Terminal startest. Füge nur Befehle hinzu, denen du vertraust.",
  stdioCliConfirm: "Bestätigen und speichern",
};
