export const assistantSettingsCopy = {
  tabsLabel: "Agenten-Einstellungen",
  tabs: {
    overview: "Überblick",
    identity: "Identität",
    capabilities: "Fähigkeiten",
    access: "Zugriffe",
    team: "Team",
    automation: "Automatisierung",
    channels: "Kanäle",
  },
  backToAgents: "Zurück zu Agenten",
  overviewGroups: {
    glance: "Auf einen Blick",
    glanceHint: "Was dieser Agent kann und darf. Jede Zeile öffnet ihren Tab.",
    manage: "Verwalten",
  },
  glance: {
    viaTemplate: "aus Vorlage",
    followsLead: "folgt dem Modell des leitenden Agenten",
    none: "Nichts eingeschaltet",
    memory: "Gedächtnis",
    web: "Web",
    browser: "Browser",
    documents: "Bilder",
    pdfs: "PDFs",
    reminders: "Erinnerungen",
    shell: (level) => `Shell: ${level}`,
    skills: (count) => (count === 1 ? "1 Skill" : `${count} Skills`),
    projects: (count) => (count === 1 ? "1 Projekt" : `${count} Projekte`),
    mcp: (count) => `${count} MCP`,
    ssh: (count) => `${count} SSH/SFTP`,
    github: (level) => `GitHub ${level}`,
    secrets: (count) => (count === 1 ? "1 Geheimnis" : `${count} Geheimnisse`),
    teams: (count) => (count === 1 ? "1 aktives Team" : `${count} aktive Teams`),
    checkIns: "Meldet sich von selbst",
    noCheckIns: "Meldet sich nicht von selbst",
    remindersOff: "Erinnerungen und Routinen aus",
    telegramConnected: "Telegram verbunden",
    telegramOff: "Telegram nicht verbunden",
  },
  duplicate: "Duplizieren",
  duplicateHint: "Neuer Agent mit diesen Fähigkeiten und Zugriffen",
  archiveHint: "Chat und Gedächtnis bleiben, wiederherstellbar",
  access: {
    intro:
      "Alles, worauf der Agent zugreifen darf. Angelegt wird unter Zugänge, hinzugefügt direkt in der Gruppe: tippen, anhaken, hinzufügen.",
    projects: "Projekte",
    ssh: "SSH/SFTP",
    mcp: "MCP-Server",
    pipelines: "Pipelines",
    github: "GitHub",
    secrets: "Geheimnisse",
    count: (label, count) => `${label} · ${count}`,
    countOf: (label, count, total) => `${label} · ${count} von ${total}`,
    sameAsProject: "Gleiche Einstellung wie Projekt › Agenten",
    more: (count) => `${count} weitere`,
    showAll: "Alle anzeigen",
    revoke: "Entziehen",
    revokeLabel: (name) => `${name} entziehen`,
    modeLabel: (name) => `Modus für ${name}`,
    folderLabel: (name) => `Ordnerzugriff für ${name}`,
    sessionsLabel: (name) => `Coding-Sessions für ${name}`,
    sessions: "Coding-Sessions",
    projectType: "Projekt",
    sshType: "SSH/SFTP-Zugang",
    mcpType: "MCP-Server",
    pipelineType: "Pipeline",
    secretType: "Geheimnis",
    mcpSetup: "MCP-Server einrichten",
    mcpOpen: "Öffnen",
    mcpOpenLabel: (name) => `${name} unter Zugänge öffnen`,
    empty: "Noch nichts freigegeben",
    whoUses: "Wer diesen Agenten nutzt",
  },
  sharedWithMembers: "Mit Mitgliedern geteilt",
  sharedWithMembersHint:
    "Was dieser Agent von seinem eigenen Zugriff mit seinen Mitgliedern teilt. Es gilt nur, solange er ihn selbst hat.",
  sharedWithMembersEmpty: "Dieser Agent teilt nichts mit seinen Mitgliedern.",
  sharedTo: (member) => `an ${member}`,
  allTeams: "Alle Teams aller Agenten",
  allTeamsPath: "Agenten › Teams",
  notificationsGroup: "Benachrichtigungen",
  notificationsRow: "Push auf deinen Geräten",
  notificationsPath: "Einstellungen › App & Benachrichtigungen",
  createAgent: "Agent anlegen",
  backTo: (tab) => `Zurück zu ${tab}`,
  searchProvider: (name) => `Suchanbieter · ${name}`,
  speechProvider: "Spracherkennung · Deepgram",
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
  remindersNeedCapability:
    "Erinnerungen und Routinen sind für diesen Agenten aus. Schalte „Erinnerungen und Routinen erlauben“ unter Fähigkeiten ein.",
  heartbeatNeedsMemory:
    "Braucht das Gedächtnis: Schalte „Informationen merken“ unter Fähigkeiten ein.",
  mainChatRestart: {
    group: "Gefahrenbereich",
    row: "Hauptchat neu beginnen",
    rowHint: "Beginnt jeden Hauptchat dieses Agenten neu. Das Gedächtnis bleibt.",
    title: (name) => `Hauptchat von „${name}“ neu beginnen?`,
    body: "Der Agent verliert seine bisherigen Gespräche, und alle laufende Arbeit endet sofort.",
    confirm: "Hauptchats neu beginnen und Arbeit abbrechen",
    goes: (people) =>
      people === 1
        ? "Weg: Gesprächsverlauf und Zusammenfassungen von 1 Hauptchat."
        : `Weg: Gesprächsverlauf und Zusammenfassungen von ${people} Hauptchats.`,
    stays:
      "Bleibt: Gedächtnis, Dateien, Einstellungen, Routinen und Erinnerungen. Routinen und Erinnerungen werden nicht geprüft.",
    notSaved: "Vorher wird nichts gesichert.",
    temporary: (count) =>
      count === 1
        ? "1 temporäres Mitglied endet."
        : `${count} temporäre Mitglieder enden.`,
    permanent: (count) =>
      count === 1
        ? "1 dauerhaftes Mitglied beginnt neu."
        : `${count} dauerhafte Mitglieder beginnen neu.`,
    workIntro: "Diese Arbeit wird abgebrochen:",
    work: {
      turns: (count) => (count === 1 ? "1 laufender Turn" : `${count} laufende Turns`),
      teams: (count) =>
        count === 1
          ? "1 Teamvorschlag, der auf Freigabe wartet"
          : `${count} Teamvorschläge, die auf Freigabe warten`,
      members: (count) =>
        count === 1
          ? "1 arbeitendes temporäres Mitglied"
          : `${count} arbeitende temporäre Mitglieder`,
      requests: (count) =>
        count === 1
          ? "1 offene Anfrage an ein dauerhaftes Mitglied"
          : `${count} offene Anfragen an dauerhafte Mitglieder`,
      coding: (count) =>
        count === 1
          ? "1 Coding-Session oder Workflow"
          : `${count} Coding-Sessions und Workflows`,
      goals: (count) =>
        count === 1 ? "1 aktives Arbeitsziel" : `${count} aktive Arbeitsziele`,
      approvals: (count) =>
        count === 1 ? "1 wartende Freigabe" : `${count} wartende Freigaben`,
    },
    archived: "Die alten Hauptchats bleiben unter den archivierten Chats lesbar.",
    acknowledge: "Ich verstehe, dass das nicht rückgängig gemacht werden kann",
    loading: "Prüfe, was der Neubeginn betrifft …",
    loadFailed: "Was der Neubeginn betrifft, ließ sich nicht laden.",
    done: "Hauptchats neu begonnen. Die vorherigen liegen unter den archivierten Chats.",
  },
};
