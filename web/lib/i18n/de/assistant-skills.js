export const assistantSkillsCopy = {
  title: "Skills",
  intro:
    "Mit OpenClaw mitgelieferte Skills bringen dem Agenten ein Werkzeug bei, meist ein Kommandozeilenprogramm. Schalte die ein, die dieser Agent nutzen darf.",
  row: "Mitgelieferte Skills",
  shellOff:
    "Die meisten Skills führen Kommandozeilenprogramme aus und brauchen Shell-Zugriff.",
  pageHint:
    "Angeboten werden nur Skills, die mit OpenClaw mitgeliefert werden. Ein Skill ist ein Hinweis, keine Berechtigung: Was der Agent ausführen darf, entscheidet der Shell-Zugriff. Die Beschreibungen stammen von OpenClaw und bleiben englisch.",
  search: "Skills suchen",
  filter: "Anzeigen",
  filters: {
    all: "Alle",
    on: "Eingeschaltet",
    ready: "Bereit",
    missing: "Etwas fehlt",
  },
  loading: "Skills werden geladen …",
  empty: "Keine Skills passen.",
  unavailable: "Skills lassen sich anzeigen, solange der Agentendienst läuft.",
  states: {
    ready: "Bereit",
    missing: "Fehlt",
    unsupported: "Auf diesem System nicht verfügbar",
    disabled: "In OpenClaw abgeschaltet",
    unavailable: "In dieser OpenClaw-Version nicht mehr enthalten",
    shadowed:
      "Verdeckt von einem gleichnamigen Skill im Ordner des Agenten; der mitgelieferte Skill wird nicht genutzt",
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
  riskLabel: "Achtung",
  count: (on) => `${on} an`,
};
