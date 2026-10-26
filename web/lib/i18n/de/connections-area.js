// Zugänge: geteilte Zugangsdaten, einmal angelegt und dort freigegeben, wo sie genutzt
// werden. Die Kategorien behalten die Namen aus Accounts und Einstellungen › Zugriff.
export const connectionsAreaCopy = {
  title: "Zugänge",
  intro:
    "Einmal anlegen, überall freigeben. Welcher Agent was nutzt, steht bei jedem Eintrag.",
  categoriesLabel: "Kategorien",
  sections: {
    models: "Modell-Zugänge",
    services: "Dienste für Agenten",
    "mcp-servers": "MCP-Server",
    ssh: "SSH/SFTP-Zugänge",
    secrets: "Geheimnisse",
    github: "GitHub-Zugänge",
  },
  breadcrumb: (section) => `Zugänge · ${section}`,
  flagged: (count) => (count === 1 ? "1 mit Problem" : `${count} mit Problem`),
  problemHint:
    "Hervorgehobene Zahl: Einträge mit Problem (Test fehlgeschlagen, Anmeldung abgelaufen, Update nötig).",
  unknownCount: "Noch unbekannt",
  loading: "Wird geladen …",
  selectHint: "Wähle einen Eintrag in der Liste.",
  backToList: (section) => `Zurück zu ${section}`,
  views: {
    label: "Ansichten",
    all: "Alle",
    problems: (count) => `Mit Problemen · ${count}`,
    unused: (count) => `Nicht benutzt · ${count}`,
    today: "Heute benutzt",
  },
  lastUseCovers: (parts) => `„Zuletzt benutzt“ und „Heute benutzt“ zählen nur ${parts}.`,
  lastUseParts: {
    agentSsh: "SSH-Befehle von Agenten",
    agentSftp: "SFTP-Übertragungen von Agenten",
    sessionSftp: "SFTP-Übertragungen von Sessions",
  },
  lastUseUnknown: "Wann ein Eintrag zuletzt benutzt wurde, ist gerade nicht bekannt.",
  searchLabel: "Liste durchsuchen",
  searchSsh: "Name, Host, Benutzer …",
  searchMcp: "Name, Adresse, Befehl …",
  filterAll: (label) => `${label}: Alle`,
  filters: {
    project: "Projekt",
    type: "Typ",
    agent: "Benutzt von",
    status: "Status",
    transport: "Transport",
    cli: "CLI",
    mcpAgent: "Agent",
  },
  groupBy: "Gruppieren",
  groupOptions: { project: "Projekt", source: "Quelle", status: "Status", none: "Keine" },
  sortBy: "Sortieren",
  sortOptions: { name: "Name", changed: "Zuletzt geändert", used: "Zuletzt benutzt" },
  columns: {
    name: "Name",
    type: "Typ",
    kind: "Art",
    usedBy: "Benutzt von",
    status: "Status",
    last: "Zuletzt benutzt",
    source: "Quelle",
  },
  selectVisible: "Alle sichtbaren auswählen",
  selectRow: (name) => `${name} auswählen`,
  groupCount: (count) => String(count),
  groupProblems: (count) => (count === 1 ? "1 mit Problem" : `${count} mit Problem`),
  showMore: (count) => `Weitere ${count} anzeigen`,
  footer: (count, groups, problems) =>
    `${count} ${count === 1 ? "Eintrag" : "Einträge"}${
      groups > 1 ? ` in ${groups} Gruppen` : ""
    }${problems ? ` · ${problems} mit Problem` : ""}`,
  keyboardHint: "↑↓ navigieren · Leertaste auswählen · Enter öffnen",
  noMatches: (query) =>
    query ? `Keine Treffer für „${query}“` : "Keine passenden Einträge",
  activeFilters: (count) => (count === 1 ? "1 Filter aktiv." : `${count} Filter aktiv.`),
  resetFilters: "Filter zurücksetzen",
  selected: (count) => `${count} ausgewählt`,
  clearSelection: "Auswahl aufheben",
  bulkLabel: "Sammelaktionen",
  notUsed: "Nicht benutzt",
  unknownUsage: "—",
  usedSummary: {
    agents: (count) => (count === 1 ? "1 Agent" : `${count} Agenten`),
    hooks: (count) => (count === 1 ? "1 Hook" : `${count} Hooks`),
    sessions: (count) => (count === 1 ? "1 Session" : `${count} Sessions`),
  },
  never: "—",
  sshStatus: {
    ok: "OK",
    failed: "Test fehlgeschlagen",
    hostKey: "Hostschlüssel geändert",
    untested: "Ungetestet",
  },
  mcpStatus: {
    ok: "OK",
    loginRequired: "Anmeldung abgelaufen",
    updateAvailable: "Update verfügbar",
    installFailed: "Installationsfehler",
    cliError: "CLI-Fehler",
  },
  mcpSources: {
    remote: "HTTP · Internet",
    package: "Pakete (npm, PyPI)",
    command: "Eigene Befehle",
  },
  mcpSourceShort: { oauth: "OAuth", headers: "Header", command: "Befehl" },
  details: "Details",
  fullView: "Vollansicht",
  edit: "Bearbeiten",
  sshKind: "SSH-Zugang",
  sftpKind: "SFTP-Zugang",
  mcpKind: "MCP-Server",
  foundInClis: "In den CLIs gefunden",
  factLabels: {
    clis: "Coding-CLIs",
  },
  checkStatus: "Status prüfen",
  usedBy: {
    title: "Benutzt von",
    titleCount: (count) => `Benutzt von · ${count}`,
    agentKinds: { agent: "Agent", teamMember: "Temporäres Team-Mitglied" },
    viaLead: (lead) => (lead ? `Von ${lead} geteilt` : "Vom leitenden Agenten geteilt"),
    hook: (name) => `Hook „${name}“`,
    hookOf: (agent) => `von ${agent}`,
    sessions: (count) =>
      count === 1 ? "1 Coding-Session läuft" : `${count} Coding-Sessions laufen`,
    sessionsHint: "Beim Start oder im Session-Kopf gewählt",
    project: "Projekt",
    pipelinesNone: "Pipelines speichern keine Zugänge.",
    none: "Noch nicht in Benutzung.",
    unknown: "Wer diesen Eintrag nutzt, ist gerade nicht bekannt.",
    agentsOff: "Agenten sind aus; nur Sessions und Projekte werden gezeigt.",
    mode: (name) => `Modus für ${name}`,
    level: (name) => `GitHub-Zugriff für ${name}`,
    revoke: "Entziehen",
    revokeNamed: (name) => `${name} entziehen`,
    revokeTitle: (agent, item) => `${agent} den Zugriff auf ${item} entziehen?`,
    revokeBody:
      "Der Agent kann diesen Eintrag nicht mehr nutzen. Du kannst ihn später wieder freigeben.",
    revokeNow: "Jetzt entziehen",
    raiseTitle: (agent) => `${agent} ohne Rückfrage arbeiten lassen?`,
    raiseConfirm: "Modus ändern",
    addAgent: "Agent",
    noCandidates: "Es gibt keinen Agenten, dem du das freigeben kannst.",
    lockedHint:
      "Agenten von Benutzern und temporäre Team-Mitglieder bekommen diesen Zugriff nicht.",
    githubReplaceHint:
      "Ein Agent hat höchstens einen GitHub-Zugang; Hinzufügen hier ersetzt seinen bisherigen.",
    failed: (name, reason) => `${name}: ${reason}`,
    leadShareHint:
      "Vom leitenden Agenten geteilt: Das änderst du in den Einstellungen des leitenden Agenten.",
  },
  manage: {
    title: "Verwalten",
    activity: "Aktivität",
    activityHint: "Aufrufe, Freigaben und Änderungen dieses Eintrags",
    activityLink: "Im Aktivitätsprotokoll",
    reassign: "Projektressourcen neu zuweisen",
    reassignHint: "Zugänge und Schlüssel von einem Projekt zum anderen",
    reassignButton: "Neu zuweisen",
    deleteAccess: "Zugang löschen",
    deleteTitle: (name) => `${name} löschen?`,
    deleteImpact: (agents, hooks) =>
      agents || hooks
        ? `${agents === 1 ? "1 Agent" : `${agents} Agenten`} und ${
            hooks === 1 ? "1 Hook" : `${hooks} Hooks`
          } verlieren den Zugriff`
        : "Niemand nutzt diesen Zugang.",
    deleteImpactUnknown: "Wer diesen Zugang nutzt, ist gerade nicht bekannt.",
  },
  test: {
    title: "Letzter Test",
    never: "Noch nicht getestet.",
    ok: (time) => `Test erfolgreich · ${time}`,
    failed: (time) => `Test fehlgeschlagen · ${time}`,
    hostKey: (time) => `Hostschlüssel geändert · ${time}`,
    rejected: "Die Verbindung steht; der Testbefehl wurde abgelehnt.",
    run: "Verbindung testen",
    again: "Erneut testen",
    running: "Wird getestet …",
    hintKey: "Liegt der öffentliche Schlüssel auf dem Host?",
    affected: (names) => `Betroffen: ${names}`,
  },
  hostKey: {
    title: "Hostschlüssel geändert",
    body: "Der Host meldet einen anderen Schlüssel als fixiert. Verbindungen sind gesperrt, bis du entscheidest.",
    pinned: "Fixiert",
    now: "Jetzt",
    fetch: "Aktuellen Hostschlüssel abrufen",
    fetching: "Wird abgerufen …",
    hint: "Nur übernehmen, wenn du weißt, warum er sich geändert hat (z. B. Neuinstallation).",
    accept: "Neuen Schlüssel übernehmen",
    keepBlocked: "Gesperrt lassen",
    acceptTitle: (name) => `Neuen Hostschlüssel von ${name} übernehmen?`,
    acceptBody:
      "AgentPier vertraut dann dem neuen Schlüssel für jeden Agenten, Hook und jede Session, die diesen Zugang nutzen.",
    acceptNow: "Jetzt übernehmen",
    accepted: "Der neue Hostschlüssel ist fixiert.",
  },
  sshForm: { unsaved: "Änderungen gelten für alle, die den Zugang nutzen." },
  bulk: {
    grant: "Agent freigeben …",
    test: "Testen",
    assignProject: "Projekt zuweisen …",
    revoke: "Entziehen …",
    delete: "Löschen",
    bindCli: "An CLI binden …",
    checkUpdates: "Updates prüfen",
    remove: "Entfernen",
    grantTitle: (count) =>
      count === 1
        ? "1 Zugang für Agenten freigeben"
        : `${count} Zugänge für Agenten freigeben`,
    grantMcpTitle: (count) =>
      count === 1
        ? "1 MCP-Server für Agenten freigeben"
        : `${count} MCP-Server für Agenten freigeben`,
    agents: "Agenten",
    mode: "Modus",
    grantButton: (count) =>
      count === 1 ? "Für 1 Agenten freigeben" : `Für ${count} Agenten freigeben`,
    revokeTitle: (count) =>
      count === 1 ? "1 Zugang Agenten entziehen" : `${count} Zugänge Agenten entziehen`,
    revokeBody:
      "Die gewählten Agenten verlieren diese Zugänge. Hooks behalten ihre eigene Auswahl.",
    revokeButton: (count) =>
      count === 1 ? "1 Agenten entziehen" : `${count} Agenten entziehen`,
    noAgents: "Kein Agent nutzt die ausgewählten Zugänge.",
    testTitle: (count) =>
      count === 1 ? "1 Zugang wird getestet" : `${count} Zugänge werden getestet`,
    progress: (done, total) => `${done} von ${total}`,
    deleteTitle: (count) =>
      count === 1 ? "1 SSH/SFTP-Zugang löschen?" : `${count} SSH/SFTP-Zugänge löschen?`,
    deleteBody:
      "Ihre Schlüssel bleiben. Agenten, Hooks und Sessions, die sie nutzen, verlieren den Zugriff; das lässt sich nicht rückgängig machen.",
    affectedAgents: "Agenten",
    affectedHooks: "Hooks",
    affectedSessions: "Sessions",
    affectedUnknown: "Gerade nicht bekannt",
    nobody: "Niemand",
    deleteNow: "Jetzt löschen",
    removeTitle: (count) =>
      count === 1 ? "1 MCP-Server entfernen?" : `${count} MCP-Server entfernen?`,
    removeBody:
      "Die Server verschwinden aus jeder Coding-CLI und jedem Agenten, die sie nutzen. Pakete werden deinstalliert.",
    removeNow: "Jetzt entfernen",
    bindTitle: (count) =>
      count === 1
        ? "1 MCP-Server an Coding-CLIs binden"
        : `${count} MCP-Server an Coding-CLIs binden`,
    bindBody:
      "Die gewählten CLIs kommen dazu; CLIs, die ein Server schon nutzt, bleiben.",
    bindButton: "Binden",
    unsupported: (cli) => `${cli} unterstützt diesen Server nicht.`,
    consent: "Ich erlaube, dass lokale Befehle für die gewählten Ziele laufen.",
    projectTitle: "Projekt zuweisen",
    projectBody:
      "Ein Zugang wechselt nur zusammen mit allen Zugängen und Schlüsseln seines Projekts: AgentPier kann keinen einzelnen Zugang verschieben, weil sein Schlüssel zum Projekt gehört.",
    projectMixed:
      "Die ausgewählten Zugänge gehören zu verschiedenen Projekten. Wähle Zugänge eines Projekts, um dessen Ressourcen zu verschieben.",
    projectGlobal:
      "Globale Zugänge lassen sich keinem Projekt zuweisen. Lege den Zugang stattdessen im Projekt neu an.",
    projectMove: (name) => `Alle Zugänge und Schlüssel von ${name} verschieben`,
    resultsTitle: "Ergebnisse",
    resultOk: "Erledigt",
    resultFailed: (reason) => `Fehlgeschlagen: ${reason}`,
    summary: (ok, failed) =>
      failed ? `${ok} erledigt, ${failed} fehlgeschlagen` : `${ok} erledigt`,
    close: "Schließen",
    upToDate: "Aktuell",
    updateTo: (version) => `Update verfügbar: ${version}`,
    noPackage: "Kein Paket: nichts zu prüfen",
    gone: "Der Eintrag existiert nicht mehr.",
  },
  empty: {
    ssh: {
      title: "Noch keine SSH- oder SFTP-Zugänge",
      body: "Zugänge mit fixiertem Hostschlüssel, die du Agenten, Hooks und Sessions freigeben kannst.",
      primary: "Zugang hinzufügen",
      secondary: "SSH-Schlüssel hinzufügen",
    },
    keys: {
      title: "Noch keine SSH-Schlüssel",
      body: "Erzeuge oder importiere einen Schlüssel; Zugänge melden sich dann damit an.",
      primary: "SSH-Schlüssel hinzufügen",
    },
    "mcp-servers": {
      title: "Noch keine MCP-Server",
      body: "Lege einen Server einmal an und wähle, welche Coding-CLIs und Agenten ihn nutzen.",
      primary: "MCP-Server hinzufügen",
      secondary: "In den CLIs gefunden",
    },
    secrets: {
      title: "Noch keine Geheimnisse",
      body: "Tokens und Adressen, die Agenten und Coding-CLIs als Umgebungsvariablen bekommen.",
      primary: "Neues Geheimnis",
    },
    github: {
      title: "Noch keine GitHub-Zugänge",
      body: "Tokenprofile für Clones, Pull Requests und Agenten mit GitHub-Zugriff.",
      primary: "Zugang hinzufügen",
    },
  },
  githubUsedBy: (count) => `Benutzt von ${count}`,
  githubDetails: (name) => `Details von ${name}`,
  githubLevels: { read: "Lesen", write: "Lesen und schreiben" },
};
