export const systemStatusCopy = {
  title: "Systemstatus",
  rowLabel: "Systemstatus. Details öffnen",
  disk: "Speicher",
  cpu: "CPU",
  memory: "RAM",
  loading: "Systemstatus wird gelesen …",
  unavailable: "Systemstatus nicht verfügbar",
  diskValue: (free, total) => `${free} frei von ${total}`,
  usedValue: (used, total) => `${used} von ${total}`,
  cpuValue: (percent, cores) => `${percent} von ${cores} Kernen`,
  diskLowTitle: "Speicherplatz wird knapp",
  diskLow: (percent, threshold) =>
    `Auf dem Laufwerk mit den AgentPier-Daten sind nur noch ${percent} frei (Warnung unter ${threshold}). Lösche alte Sicherungen oder ungenutzte Daten, bevor das Laufwerk voll ist.`,
  legacyTmuxTitle: (count) =>
    count === 1
      ? "1 Session läuft noch auf dem alten tmux-Server"
      : `${count} Sessions laufen noch auf dem alten tmux-Server`,
  legacyTmux: (count) =>
    `Stoppe ${count === 1 ? "diese Session" : "diese Sessions"}, wenn es dir passt; danach startet AgentPier neue Sessions auf dem neuen Server.`,
  legacyTmuxSessions: "Sessions auf dem alten tmux-Server",
  host: {
    computer: "Dieser Computer",
    cores: (count) => (count === 1 ? "1 Kern" : `${count} Kerne`),
    memory: (size) => `${size} RAM`,
    platforms: { darwin: "macOS", linux: "Linux" },
  },
  live: "Live · alle 5 s",
  tabsLabel: "Bereiche des Systemstatus",
  tabs: { load: "Auslastung", processes: "Prozesse", storage: "Speicher" },
  reclaimable: (size) => `${size} freigebbar`,
  load: (one, five, fifteen) => `Durchschnittslast ${one} · ${five} · ${fifteen}`,
  historyHeading: "Verlauf",
  range: { label: "Zeitraum", quarter: "15 Min", hour: "1 Std" },
  rangeName: { quarter: "15 Minuten", hour: "Stunde" },
  historyAgo: (minutes) => `−${minutes} Min`,
  historyNow: "jetzt",
  historyTime: "Zeit",
  historyGapNote:
    "Schraffiert: keine Messung, weil keine Ansicht offen war. Eine Messung pro Minute, alle 5 s, solange der Systemstatus offen ist.",
  historyEmpty:
    "Der Verlauf füllt sich in der ersten Stunde nach dem Start von AgentPier: eine Messung pro Minute, alle fünf Sekunden, solange diese Ansicht offen ist.",
  historyCpu: "CPU",
  historyMemory: "RAM",
  historyAgentPier: "AgentPier-CPU",
  historyLabel: (range, cpu, memory, agentPier) =>
    `CPU, RAM und AgentPier-CPU der letzten ${range}; jetzt ${cpu}, ${memory} und ${agentPier}`,
  shareHeading: "Anteil von AgentPier",
  shareLink: "Nach Prozessen aufschlüsseln",
  shareCpu: "CPU des Computers",
  shareMemory: "RAM des Computers",
  shareOf: (part, whole) => `${part} von ${whole}`,
  shareOfUsed: (part, whole) => `${part} von ${whole} belegt`,
  shareAgentPier: "AgentPier",
  shareOther: "Andere Programme",
  processTotalCpu: "AgentPier gesamt · CPU",
  processSort: "Sortieren",
  processSortName: "Name",
  processName: "Teil",
  processActions: "Aktionen",
  processes: (count) => (count === 1 ? "1 Prozess" : `${count} Prozesse`),
  groupCore: "AgentPier-Kern",
  groupSessions: (count) =>
    count === 1 ? "Sessions · 1 läuft" : `Sessions · ${count} laufen`,
  serverSub: "Web-Oberfläche, API, tmux",
  gatewaySub: "OpenClaw · führt die Agenten aus",
  openSession: "Öffnen",
  openSessionLabel: (name) => `${name} öffnen`,
  processCount: "Prozesse",
  processCpu: "CPU",
  processMemory: "RAM",
  server: "AgentPier-Server",
  gateway: "Agenten-Gateway",
  session: (name) => name || "Session",
  sessionTool: {
    claude: "Claude Code",
    codex: "Codex",
    opencode: "OpenCode",
    shell: "Shell",
  },
  noSessions: "Keine Session läuft.",
  dataHeading: "Datenverzeichnis",
  dataPending: "Das Datenverzeichnis wird im Hintergrund vermessen …",
  dataRefreshing: "Größen werden aktualisiert …",
  dataPartial: "Das Datenverzeichnis ist sehr groß; die Größen erfassen nur einen Teil.",
  dataMeasured: (time) => `Gemessen ${time}`,
  dataTotal: (total) => `${total} insgesamt`,
  dataUsed: "Belegt",
  dataReclaimable: "Davon freigebbar",
  dataMore: (count, size) => `${count} weitere · ${size}`,
  dataFewer: "Weniger anzeigen",
  driveHeading: "Laufwerk mit den AgentPier-Daten",
  driveAgentPier: (size) => `AgentPier ${size}`,
  driveOther: (size) => `Andere Daten ${size}`,
  driveFree: (size) => `Frei ${size}`,
  driveNote: (threshold) =>
    `Warnung auf der Startseite, sobald weniger als ${threshold} frei sind.`,
  areas: {
    profiles: "CLI-Profile",
    clis: "CLI-Installationen",
    tools: "Toolchains und MCP-Pakete",
    runtimes: "Agenten-Laufzeiten",
    backups: "Sicherungen",
    chatAttachments: "Chat-Anhänge",
    agentAttachments: "Agenten-Anhänge",
    agentShares: "Agenten-Freigaben",
    agentWorkspaces: "Agenten-Arbeitsbereiche",
    secrets: "Geheimnisse",
    logs: "Protokolle",
    other: "Sonstiges",
  },
  cleanup: {
    heading: "Speicher freigeben",
    upTo: (size) => `Bis zu ${size} lassen sich löschen`,
    measuredOnOpen: "Wird beim Öffnen gemessen",
    footnote:
      "Gelöscht wird erst nach Auswahl und Bestätigung. Was gerade benutzt wird, bleibt.",
    open: "Aufräumen …",
    measuring: "Es wird gemessen, was gelöscht werden kann …",
    atLeast: (size) => `mindestens ${size}`,
    freed: (size) => `Gelöscht. ${size} freigegeben.`,
    none: "Es wurde nichts gelöscht.",
    skipped: (count) =>
      count === 1
        ? "1 Eintrag ist geblieben: Er hat sich inzwischen geändert oder wird benutzt."
        : `${count} Einträge sind geblieben: Sie haben sich inzwischen geändert oder werden benutzt.`,
    snapshots: {
      title: "Update-Sicherungen",
      sub: "Zustand und Laufzeit der Agenten vor jedem Laufzeit-Update",
      caveat: "Weg zurück zur alten Laufzeit entfällt",
      facts: (count, oldest) =>
        count === 1
          ? `1 Sicherung · vom ${oldest}`
          : `${count} Sicherungen · älteste vom ${oldest}`,
      label: "Gespeicherte Update-Sicherungen",
      empty: "Es ist keine Update-Sicherung gespeichert.",
      versions: (from, to) => `Update ${from} → ${to}`,
      unknownVersions: "Update der Agenten-Laufzeit",
      recovery: "Ein unfertiges Update braucht sie noch",
      blocked:
        "Ein Update der Agenten-Laufzeit läuft oder braucht seine Sicherungen. Lösche Sicherungen, wenn es fertig ist.",
      deleteLabel: (date) => `Update-Sicherung vom ${date} löschen`,
      confirmTitle: (date) => `Update-Sicherung vom ${date} löschen?`,
      confirmBody: (size) => `Das gibt ${size} frei.`,
      confirmWarning: (version) =>
        version
          ? `Der Weg zurück zur vorherigen Agenten-Laufzeit (${version}) entfällt: AgentPier kann Zustand und Laufzeit der Agenten von vor diesem Update nicht mehr wiederherstellen.`
          : "Der Weg zurück zur vorherigen Agenten-Laufzeit entfällt: AgentPier kann Zustand und Laufzeit der Agenten von vor diesem Update nicht mehr wiederherstellen.",
      confirm: "Sicherung löschen",
    },
    transcripts: {
      title: "Verläufe in CLI-Profilen",
      sub: "Gespräche beendeter Sessions von Claude Code und Codex",
      caveat: "Diese Sessions lassen sich nicht fortsetzen",
      facts: (count, days, profiles) =>
        `${count === 1 ? "1 Verlauf" : `${count} Verläufe`} älter als ${days} Tage · ${profiles === 1 ? "1 Profil" : `${profiles} Profile`}`,
      label: "Verläufe nach CLI-Profil",
      age: "Zuletzt geändert vor mehr als",
      days: (days) => `${days} Tagen`,
      empty: "In AgentPier ist kein Claude-Code- oder Codex-Profil eingerichtet.",
      summary: (count, size) =>
        count === 1 ? `1 Verlauf · ${size}` : `${count} Verläufe · ${size}`,
      none: "Nichts so Altes",
      kept: (count) =>
        count === 1
          ? "1 weiterer bleibt: AgentPier listet seine Session noch"
          : `${count} weitere bleiben: AgentPier listet ihre Sessions noch`,
      deleteLabel: (name) => `Alte Verläufe von ${name} löschen`,
      confirmTitle: (name, days) =>
        `Verläufe von „${name}“ löschen, die älter als ${days} Tage sind?`,
      confirmBody: (count, size, days) =>
        count === 1
          ? `Das löscht 1 Verlauf einer beendeten Session, zuletzt vor mehr als ${days} Tagen geändert, und gibt ${size} frei.`
          : `Das löscht ${count} Verläufe beendeter Sessions, zuletzt vor mehr als ${days} Tagen geändert, und gibt ${size} frei.`,
      confirmWarning:
        "Diese Sessions lassen sich nicht mehr fortsetzen und ihr Verlauf ist weg. Verläufe von Sessions, die AgentPier noch listet, laufend oder gestoppt, bleiben.",
      codexNote:
        "Codex verzeichnet seine Threads zusätzlich in eigenen Datenbanken. AgentPier lässt sie unverändert, daher listet Codex diese Threads womöglich weiter, ohne ihren Verlauf.",
      confirm: "Verläufe löschen",
    },
    dependencies: {
      title: "Installierte Abhängigkeiten der Agenten",
      sub: "node_modules-Ordner in den Arbeitsbereichen der Agenten",
      caveat: "Wird bei Bedarf neu installiert",
      facts: (folders, agents) =>
        `${folders} Ordner bei ${agents === 1 ? "1 Agenten" : `${agents} Agenten`}`,
      label: "Installierte Abhängigkeiten nach Agent",
      empty: "Kein Arbeitsbereich eines Agenten enthält installierte Abhängigkeiten.",
      folders: (count) =>
        count === 1 ? "1 node_modules-Ordner" : `${count} node_modules-Ordner`,
      working:
        "Der Agent arbeitet gerade. Lösche seine Abhängigkeiten, wenn er fertig ist.",
      removedAgent: "Entfernter Agent",
      deleteLabel: (name) => `Installierte Abhängigkeiten von ${name} löschen`,
      confirmTitle: (name) => `Installierte Abhängigkeiten von „${name}“ löschen?`,
      confirmBody: (count, size) =>
        count === 1
          ? `Das löscht 1 node_modules-Ordner im Arbeitsbereich des Agenten und gibt ${size} frei.`
          : `Das löscht ${count} node_modules-Ordner im Arbeitsbereich des Agenten und gibt ${size} frei.`,
      confirmWarning:
        "Die eigenen Dateien des Agenten bleiben. Er installiert die Abhängigkeiten wieder, wenn ein Projekt sie braucht (npm install); das kostet Zeit und braucht eine Netzwerkverbindung.",
      confirm: "Abhängigkeiten löschen",
    },
  },
  cpuNote:
    "CPU-Anteile beziehen sich auf den ganzen Computer, alle Kerne zusammen. Die Agenten laufen alle im Agenten-Gateway; gestoppte Sessions belegen nichts.",
};
