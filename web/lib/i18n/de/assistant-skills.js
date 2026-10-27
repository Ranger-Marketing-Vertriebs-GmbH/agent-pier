export const assistantSkillsCopy = {
  title: "Skills",
  intro:
    "Skills bringen dem Agenten ein Tool bei, meist ein Kommandozeilenprogramm. Schalte die mitgelieferten oder Katalog-Skills ein, die dieser Agent nutzen darf; Katalog-Skills installierst du unter Agenten › Skills.",
  row: "Skills",
  shellOff:
    "Die meisten Skills führen Kommandozeilenprogramme aus und brauchen Shell-Zugriff.",
  pageHint:
    "Angeboten werden mit OpenClaw mitgelieferte Skills und Skills aus dem Skill-Katalog; Katalog-Skills installierst du unter Agenten › Skills. Ein Skill ist ein Hinweis, keine Berechtigung: Was der Agent ausführen darf, entscheidet der Shell-Zugriff. Die Beschreibungen stammen von OpenClaw und bleiben englisch.",
  search: "Skills suchen",
  filter: "Anzeigen",
  filters: {
    all: "Alle",
    on: "Eingeschaltet",
    ready: "Bereit",
    missing: "Etwas fehlt",
    catalog: "Aus dem Katalog",
  },
  loading: "Skills werden geladen …",
  empty: "Keine Skills passen.",
  unavailable: "Skills lassen sich anzeigen, solange der Agentendienst läuft.",
  offlineHint:
    "Diese Skills kannst du jetzt ausschalten; zum Einschalten braucht es den Agentendienst.",
  states: {
    ready: "Bereit",
    missing: "Fehlt",
    unsupported: "Auf diesem System nicht verfügbar",
    disabled: "In OpenClaw abgeschaltet",
    unavailable: "In dieser OpenClaw-Version nicht mehr enthalten",
    needsSettings: "Braucht Einstellungen \u2014 noch nicht unterstützt",
    damaged: "Beschädigt \u2014 installiere ihn unter Agenten \u203a Skills neu",
    shadowedCatalog:
      "Aus: Ein mitgelieferter Skill gleichen Namens ersetzt diesen Katalog-Skill. Entferne den Katalog-Skill, um den mitgelieferten zu nutzen.",
    shadowed:
      "Für diesen Agenten aus: Ein gleichnamiger Skill in den Ordnern des Agenten würde an seiner Stelle laufen. Deine Auswahl bleibt gespeichert und gilt wieder, sobald dieser Skill entfernt ist.",
  },
  missing: {
    bins: (names) => `Programme ${names}`,
    anyBins: (names) => `eines von ${names}`,
    env: (names) => `Umgebungsvariablen oder API-Schlüssel ${names}`,
    config: (names) => `Einstellungen ${names}`,
    os: (names) => `Betriebssystem ${names}`,
  },
  missingLine: (parts) => `Fehlt: ${parts}`,
  needsShell: "Braucht Shell-Zugriff",
  fromCatalogPlain: "Aus dem Skill-Katalog",
  fromCatalog: (version) => `Aus dem Skill-Katalog \u00b7 Version ${version}`,
  worksWithLimits:
    "Funktioniert eingeschränkt: Er führt Programme aus, und dieser Agent hat keinen Shell-Zugriff.",
  pending: "Gilt ab der nächsten Antwort des Agenten",
  risks: {
    installsCode:
      "Achtung: Dieser Skill kann fremden Code installieren oder neue Skills schreiben.",
    steersGateway:
      "Achtung: Dieser Skill steuert den Agentendienst selbst. AgentPier hält diese Oberflächen ausgeschaltet.",
    changesHost:
      "Achtung: Dieser Skill ändert Sicherheitseinstellungen dieses Rechners (SSH, Firewall).",
    duplicates:
      "Achtung: Dieser Skill umgeht eine Funktion, die AgentPier selbst verwaltet (Coding-Läufe, MCP-Server oder die Leinwand).",
    secrets: "Achtung: Dieser Skill liest Geheimnisse aus deinem Passwortmanager.",
  },
  count: (on) => `${on} an`,
};
