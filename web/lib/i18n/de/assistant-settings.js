export const assistantSettingsCopy = {
  tabsLabel: "Agenten-Einstellungen",
  tabs: {
    profile: "Profil",
    capabilities: "Fähigkeiten",
    work: "Arbeit",
    telegram: "Telegram",
  },
  createAgent: "Agent anlegen",
  backTo: (tab) => `Zurück zu ${tab}`,
  searchProvider: (name) => `Suchanbieter · ${name}`,
  searchProviders: {
    duckduckgo: "DuckDuckGo",
    perplexity: "Perplexity",
    brave: "Brave Search",
  },
  manageMcpServers: "MCP-Server verwalten",
  pendingApprovals: (count) => `Wartet auf deine Freigabe · ${count}`,
  numberRange: (min, max) => `Gib eine ganze Zahl von ${min} bis ${max} ein.`,
  teamGroup: "Team",
  connectionGroup: "Verbindung",
  connectionPage: "Verbindung",
  activityAttention: (count) =>
    count === 1 ? "1 braucht deine Entscheidung" : `${count} brauchen deine Entscheidung`,
  allDelivered: "Alles zugestellt",
  noActivity: "Noch keine Aktivität",
  replaceToken: "Bot-Token ersetzen",
  replaceTokenHint: "Nur ein neuer Token desselben Bots wird angenommen.",
  addReminder: "+ Erinnerung erstellen",
  addRoutine: "+ Routine",
  heartbeatNeedsMemory:
    "Braucht das Gedächtnis: Schalte „Informationen merken“ unter Fähigkeiten ein.",
};
