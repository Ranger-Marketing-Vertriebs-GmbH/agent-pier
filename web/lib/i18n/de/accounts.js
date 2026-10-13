export const accountDialogCopy = {
  profileIsolationDescription:
    "Ein eigenes Profil hält Anmeldung und Konfiguration getrennt. Du kannst dich anschließend direkt im Terminal anmelden.",
  accountNamePlaceholder: "z. B. Persönlich oder Arbeit",
  toolLabel: "Tool",
  uninstalledToolSuffix: " · nicht installiert",
  apiKeyLabel: "API-Key (optional)",
  savedKeyPlaceholder: "Gespeichert · zum Ersetzen eingeben",
  nativeKeyPlaceholder: "Alternativ zur interaktiven Anmeldung",
  nativeAuthenticationHelp:
    "Bei OpenCode gilt der API-Key für OpenAI. Andere Anbieter richtest du über „Anmelden“ ein. Bei einem gespeicherten Key lässt ein leeres Feld den bisherigen Wert unverändert.",
  formNote: "Zugangsdaten werden nur lokal gespeichert.",
};
export const accountsPageCopy = {
  signedIn: "Angemeldet",
  defaultAccount: "Standard-Account",
  setDefaultAccount: "Als Standard verwenden",
  useDefaultAccount: (name) => `${name} als Standard verwenden`,
  subtle: " Lokal gespeichert",
  pageHeadingTitle: "Deine Accounts",
  pageHeadingDescription: "Ein Workspace. Für alle deine Identitäten.",
  localProfileDescription: "Vorhandenes CLI-Profil auf dem AgentPier-Server",
  managedProfileWithKey: "Eigenes Profil · API-Key gespeichert",
  managedProfileDescription: "Eigenes Profil",
  accountInfoHeading: "Alles bleibt auf deinem Rechner.",
  accountInfoDescription:
    "Eigene Profile haben getrennte Anmeldungen und Konfigurationen. Lokale Profile verwenden die vorhandene CLI-Anmeldung auf dem AgentPier-Server. Wähle ein eigenes Profil als Standard-Account, wenn dort noch keine Anmeldung besteht.",
};

export const accountsHubCopy = {
  intro:
    "Hier richtest du Zugänge einmal ein. Welcher Agent was nutzt, stellst du beim Agenten ein.",
  infoLabel: "Hinweis zu Accounts anzeigen",
  groups: {
    models: "Modell-Zugänge",
    services: "Dienste für Agenten",
    mcpServers: "MCP-Server",
    cli: "Native CLI-Accounts",
  },
  breadcrumb: (group) => `Accounts · ${group}`,
  selectHint: "Wähle links einen Eintrag.",
  loading: "Wird geladen …",
  sessionsOnly: "Sitzungen",
  sessionsCount: (count) => (count === 1 ? "1 Sitzung" : `${count} Sitzungen`),
  pipelineProfile: "Pipeline-Profil",
  usedByNone: "Noch nicht genutzt.",
  agentKinds: { agent: "Agent", teamMember: "Temporäres Teammitglied" },
  compatibleClis: "Kompatible CLIs",
  restartsAgents: (count) =>
    count === 1 ? "Startet 1 Agenten kurz neu." : `Startet ${count} Agenten kurz neu.`,
  replaceKey: "Ersetzen",
  connectionGroups: { connection: "Verbindung", test: "Test" },
  chatgptSub: (status) => `Für Agenten · ${status}`,
  chatgptConnectSub: "Anmeldung mit Gerätecode starten",
  speechProvider: "Deepgram",
  searchProviders: {
    duckduckgo: "DuckDuckGo",
    perplexity: "Perplexity",
    brave: "Brave Search",
  },
  notReady: "Nicht eingerichtet",
  cliFindsSub: "Einträge aus Claude Code, Codex und OpenCode übernehmen",
  accountActions: "Anmeldung und Standard",
};
