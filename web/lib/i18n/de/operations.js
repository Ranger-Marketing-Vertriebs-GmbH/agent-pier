const title = "Einstellungen";
const groups = {
  workspace: "Arbeitsbereich",
  access: "Zugriff",
  operations: "Betrieb",
};
const sections = {
  assistants: "Agenten",
  general: "Allgemein",
  mcp: "MCP & Zugriffe",
  remote: "Fernzugriff",
  ssh: "SSH-Zugänge",
  secrets: "Geheimnisse",
  github: "GitHub-Zugänge",
  notifications: "App & Benachrichtigungen",
  diagnostics: "Diagnose",
  backups: "Sicherungen",
  updates: "Updates",
  users: "Benutzer",
  audit: "Aktivitätsprotokoll",
};
export const operationsCopy = {
  sections,
  groups,
  title,
  description: "Arbeitsbereich, App und Betrieb verwalten.",
  loading: "Daten werden geladen …",
  refresh: "Aktualisieren",
  next: "Weiter",
  confirm: "Bestätigen",
  // ConfirmDialog-Titel nennen das Objekt; der Button wiederholt das Verb.
  confirmTitles: {
    deleteBackup: (date) => `Sicherung vom ${date} löschen?`,
    cleanup: (versions, count) =>
      count === 1
        ? `Version ${versions} löschen?`
        : `${count} Versionen löschen (${versions})?`,
    migrate: (version) => `Sessions umziehen und Version ${version} löschen?`,
    interrupt: (version) => `Sessions jetzt neu starten und Version ${version} löschen?`,
    restore: "Sicherung in einem neuen Verzeichnis wiederherstellen?",
    activate: (version) => `Version ${version} aktivieren?`,
    rollback: (version) => `Auf Version ${version} zurücksetzen?`,
    deleteStaged: (version) => `${version} löschen?`,
    orphans: (version, count) =>
      `${count} verwaiste(n) Prozess(e) der Version ${version} beenden?`,
  },
  confirmLabels: {
    deleteBackup: "Jetzt löschen",
    cleanup: "Jetzt löschen",
    migrate: "Umziehen und löschen",
    interrupt: "Neu starten und löschen",
    restore: "Jetzt wiederherstellen",
    activate: "Jetzt aktivieren",
    rollback: "Jetzt zurücksetzen",
    deleteStaged: "Jetzt löschen",
    orphans: "Jetzt beenden",
  },
  unknown: "Unbekannt",
  details: "Details",
  empty: "Keine Einträge vorhanden.",
  audit: "Aktivitätsprotokoll",
  auditHelp:
    "Ereignisse enthalten ausgewählte Metadaten. Native Inhalte und Zugangsdaten werden hier nicht protokolliert.",
  action: "Aktion",
  outcome: "Ergebnis",
  all: "Alle",
  sessionId: "Session-ID",
  projectId: "Projekt-ID",
  resourceId: "Ressourcen-ID",
  filter: "Filtern",
  clear: "Filter zurücksetzen",
  success: "Erfolgreich",
  failure: "Fehlgeschlagen",
  byOwner: "von dir (Besitzer)",
  byUser: (name) => `von ${name}`,
  byDeletedUser: "von einem gelöschten Benutzer",
  sourceSystem: "System",
  sourceMcp: "MCP",
  manageMcpAccess: "MCP-Zugriff prüfen oder widerrufen",
  diagnostics: "Diagnose",
  runChecks: "Prüfungen starten",
  scope: "Prüfumfang",
  host: "Rechner",
  project: "Projekt",
  chooseProject: "Projekt wählen",
  deep: "Vollständige Datenbankprüfung",
  deepHelp:
    "Prüft SQLite-Datenbanken vollständig statt mit einer Schnellprüfung. Das kann länger dauern und startet keine Netzwerk- oder Modellanfrage.",
  noReport: "Noch kein Diagnosebericht.",
  generatedAt: "Geprüft am",
  remedy: "Lösungsvorschlag",
  checkStatuses: {
    ok: "In Ordnung",
    warn: "Hinweis",
    fail: "Fehlgeschlagen",
    skip: "Nicht geprüft",
  },
  backups: "Sicherungen",
  createBackup: "Sicherung vorbereiten",
  includeHistory: "Verläufe einschließen",
  withCredentials: "Zugangsdaten verschlüsselt einschließen",
  backupPrivacy:
    "Session-, Chat- und AgentBus-Verläufe, CLI-Verläufe, Chats, Kanalnachrichten, Arbeitsbereiche und Anhänge der Agenten, Pipeline-Verlauf und nicht angeheftete Artefakte können private Inhalte enthalten; sie werden nur verschlüsselt in Backups mit Verläufen und Passphrase gesichert. Agenteneinstellungen, angeheftete Artefakte, Projektwissen und das Aktivitätsprotokoll werden immer unverschlüsselt gesichert. Zugangsdaten umfassen Anmeldungen, Einstellungen, Anweisungen, Skills und Agenten der verwalteten CLI-Profile; Caches, Protokolle, installierte CLIs und Laufzeiten werden nie gesichert. Externe lokale CLI-Profile, Schlüsselbunde und Repository-Arbeitsverzeichnisse bleiben außen vor.",
  historyNeedsPassphrase:
    "Ohne Passphrase bleiben Verläufe, Chats, Kanalnachrichten, Arbeitsbereiche und Anhänge der Agenten, Pipeline-Verlauf und nicht angeheftete Artefakte in dieser Sicherung außen vor; Agenten werden nur mit ihren Einstellungen wiederhergestellt. Um sie verschlüsselt zu sichern, wähle auch „Zugangsdaten verschlüsselt einschließen“ und setze eine Passphrase.",
  passphrase: "Passphrase",
  plan: "Sicherungsumfang prüfen",
  create: "Sicherung erstellen",
  components: "Bestandteile",
  omissions: "Nicht enthalten",
  consistency: "Aufnahmegrenzen",
  requiresPassphrase: "Für verschlüsselte Zugangsdaten ist eine Passphrase erforderlich.",
  assistantCredentialsNote:
    "Agent-Zugangsdaten in dieser Sicherung lassen sich nur auf diesem Host wiederherstellen. Jede Änderung an Zugangsdaten oder Provider-Zugängen macht sie unlesbar; Agenten müssen sich dann erneut anmelden.",
  download: "Herunterladen",
  deleteBackup: "Diese Sicherung löschen?",
  inspectArchive: "Sicherung prüfen und wiederherstellen",
  archive: "Sicherungsdatei",
  uploadProgress: (percent, done, total) =>
    `Sicherungsdatei wird hochgeladen: ${percent} % (${done} von ${total})`,
  inspect: "Archiv prüfen",
  targetDataDir: "Neues Datenverzeichnis",
  restore: "In neuem Verzeichnis wiederherstellen",
  restoreHelp:
    "Das Ziel muss neu sein, sein übergeordnetes Verzeichnis bereits existieren. Die laufende Anwendung und native Sessions bleiben unverändert.",
  restoreTargetRequired: "Gib das neue Datenverzeichnis an.",
  restoreMappingRequired: (projects) =>
    `Gib für jedes Projekt ein Verzeichnis an: ${projects}`,
  restorePassphraseRequired: "Gib die Passphrase der Sicherung an.",
  projectMapping: "Projektverzeichnisse zuordnen",
  restoreConfirmation:
    "Das geprüfte Archiv wird in einem neuen Datenverzeichnis wiederhergestellt. Es werden keine nativen Sessions gestartet.",
  restored: "Wiederherstellung abgeschlossen",
  credentialsRestored: "Zugangsdaten wiederhergestellt",
  yes: "Ja",
  no: "Nein",
  needsLogin: "Erneute Anmeldung erforderlich",
  needsMcpServerValues: (name) => `MCP-Server ${name} (Werte neu eingeben)`,
  needsUserPassword: (name) => `Benutzer ${name} (neues Passwort vergeben)`,
  needsMcpServerAddress: (name) =>
    `MCP-Server ${name} (Token in der Adresse neu eingeben)`,
  importedSessions: "Importierte Sessions",
  changedFilesLeftOut: "Während der Sicherung geänderte Dateien, nicht wiederhergestellt",
  importedRuns: "Importierte Läufe",
  updates: "Updates",
  currentVersion: "Installierte Version",
  channelStable: "Stable — Standard",
  channelPreview: "Preview — Vorabversionen",
  channelCustom: "Eigene Update-Quelle",
  channelStableHelp:
    "Nur freigegebene stabile Releases. Der Wechsel zu Stable installiert keine ältere Version.",
  channelPreviewHelp:
    "Preview enthält Release Candidates zum Testen sowie stabile Releases. Die Auswahl gilt für diese AgentPier-Installation. Release Candidates können unfertige Änderungen enthalten. Nachdem ein Release Candidate die Daten migriert hat, ist eine Rückkehr zur vorherigen stabilen Version unter Umständen nicht mehr möglich. Lege deshalb vorher unter Einstellungen › Betrieb › Sicherungen eine Sicherung an. Beim Wechsel zurück zu Stable bleibt der installierte Release Candidate erhalten, bis eine neuere stabile Version erscheint.",
  channelManagedHelp:
    "Eine eigene Update-Quelle ist eingerichtet. Sie wird auf dem Server verwaltet.",
  channelUnsupportedHelp:
    "Updatekanäle gelten nur für eine versionierte Installation. Diese Instanz läuft aus einem Quellcode-Checkout oder auf einer nicht unterstützten Plattform, deshalb ist die Auswahl gesperrt.",
  channelManagedSource: (source) => `Update-Quelle: ${source}`,
  stagedPrereleaseHelp:
    "Bereits vorbereitete Vorabversionen lassen sich auch nach dem Wechsel zu Stable aktivieren.",
  prerelease: "Vorabversion",
  channel: "Updatekanal",
  saveChannelFirst: "Speichere zuerst den Updatekanal.",
  channelBusy:
    "Den Updatekanal kannst du ändern, sobald der laufende Update-Auftrag beendet ist.",
  releaseNotes: "Neu in dieser Version",
  releaseNotesLoading: "Versionshinweise werden geladen …",
  releaseNotesUnavailable:
    "Versionshinweise sind gerade nicht verfügbar. Das Update ist trotzdem möglich.",
  releaseNotesOriginal: "Release auf GitHub ansehen",
  releaseNotesSince: (version) => `Neu seit Version ${version}`,
  releaseNotesPublished: (date) => `veröffentlicht am ${date}`,
  releaseNotesEmpty: "Für diese Version gibt es keine Versionshinweise.",
  releaseNotesOverflow: (count) =>
    `Es werden nur die ${count} neuesten Versionen angezeigt.`,
  releaseNotesIncomplete: "Einige Versionshinweise konnten nicht geladen werden.",
  releaseNotesAll: "Alle Releases auf GitHub ansehen",
  cleanupErrors: {
    cleanupInvalid: "Wähle gültige Versionen zum Löschen aus.",
    cleanupBusy:
      "Ein anderer Update-Vorgang läuft. Versuche es nach dessen Abschluss erneut.",
    cleanupChanged:
      "Die gewählten Versionen können nicht mehr sicher entfernt werden. Lade die Liste neu.",
    migrateBusy:
      "Ein anderer Release-Vorgang läuft. Versuche es nach dessen Abschluss erneut.",
    migrateChanged:
      "Die Sessions dieser Version haben sich geändert. Lade die Liste neu.",
    migrateFailed:
      "Einige Sessions konnten nicht neu geladen werden. Die Version bleibt erhalten.",
    migrateBlocked:
      "Prozesse verwenden diese Version weiterhin. Die Version bleibt erhalten.",
    migrateInterrupted:
      "Der Webdienst wurde beendet, bevor der Umzug abgeschlossen war. Die Version bleibt erhalten.",
    migrateCancelled: "Der Umzug wurde abgebrochen. Die Version bleibt erhalten.",
  },
  cleanupReleases: "Alte Versionen löschen",
  cleanupHelp:
    "Entferne ungenutzte ältere Versionen, um Speicherplatz freizugeben. Aktive Versionen und Versionen laufender Prozesse bleiben erhalten.",
  cleanupAll: "Alle alten Versionen löschen",
  cleanupOne: "Version löschen",
  cleanupConfirm: (versions) =>
    `Diese Versionen dauerhaft löschen: ${versions}? Sie stehen danach nicht mehr für Rollbacks bereit.`,
  cleanupUnavailable:
    "Sicheres Aufräumen ist gerade nicht möglich. Lade die Seite neu und versuche es erneut.",
  cleanupReasons: {
    active: "Aktiv",
    newer: "Neuere Version",
    inUse: "Von laufendem Prozess verwendet",
    busy: "Update läuft",
    unsafe: "Nicht unterstütztes Verzeichnis",
  },
  orphanedTitle: (count) => `Verwaiste Prozesse (${count})`,
  orphanedHelp:
    "Diese Prozesse führen nur das Node dieser Version aus, ohne AgentPier-Skript, und haben keinen Elternprozess mehr. Sie blockieren das Löschen der Version nicht; meist sind es übrig gebliebene Tests oder Skripte.",
  orphanedStop: "Prozesse beenden",
  orphanedConsequence: "Ungespeicherte Arbeit darin geht verloren.",
  orphanedStopped: (count) => `${count} Prozess(e) beendet.`,
  migrateSessions: "Sessions anzeigen",
  migrateLoading: "Sessions werden geladen …",
  migrateEmpty: "Keine AgentPier-Session hält diese Version.",
  migrateStart: "Sessions umziehen und Version löschen",
  migrateInterrupt: "Sofort umziehen und löschen",
  migrateCancel: "Umzug abbrechen",
  migrateConfirm: (version, count) =>
    `${count} Session(s) auf die aktive Version umziehen und Version ${version} danach löschen? Beschäftigte Sessions ziehen erst nach Abschluss ihres aktuellen Schritts um; Sessions mit unbekanntem Zustand warten, bis das CLI erkennbar bereit ist.`,
  migrateInterruptConfirm: (version, count) =>
    `${count} Session(s) sofort neu starten und Version ${version} danach löschen? Laufende Arbeit wird abgebrochen. Gespeicherte Unterhaltungen bleiben erhalten.`,
  migrateIneligibleHint:
    "Einige Sessions können nicht neu geladen werden. Beende sie manuell, um die Version freizugeben.",
  migrateUnidentifiedHint: (references) =>
    `Prozesse außerhalb einer Session verwenden diese Version: ${references}. Beende sie, um die Version freizugeben.`,
  migrateNodeOnly: (count) =>
    `${count} Node-Prozess(e) aus dieser Version werden nach dem Umzug erneut geprüft.`,
  migrateStates: {
    ready: "Bereit",
    busy: "Beschäftigt",
    unknown: "Zustand unbekannt",
    queued: "Wartet auf Bereitschaft",
    reloading: "Wird neu geladen",
    approval: "Wartet auf Freigabe im Terminal",
    failed: "Fehlgeschlagen",
    ineligible: "Nicht neu ladbar",
    "unsupported-session": "Pipeline-, Login- oder Shell-Session",
    "native-session-unverified": "Keine verifizierte Unterhaltung",
  },
  migrateSucceeded: (count) => `Version gelöscht, ${count} Session(s) neu geladen.`,
  migrateFailedSessions: "Nicht neu geladen",
  migrateRemaining: "Weiterhin verwendet von",
  activateReload: "Laufende Sessions danach auf die neue Version umziehen",
  activateReloadHelp:
    "Der Umzug beginnt, nachdem die neue Version ihre Zustandsprüfung bestanden hat. Beschäftigte Sessions ziehen nach Abschluss ihres aktuellen Schritts um; nichts wird unterbrochen. Sessions, die nicht neu geladen werden können, laufen auf der bisherigen Version weiter.",
  checkUpdates: "Nach Updates suchen",
  stageRelease: "Version vorbereiten",
  activateRelease: "Vorbereitete Version aktivieren",
  deleteStaged: "Löschen",
  deleteStagedConfirmation:
    "Das Paket wird entfernt, und diese Version lässt sich danach nicht mehr aktivieren.",
  releaseHistory: "Frühere Versionen und Rollback",
  rollback: "Version zurücksetzen",
  upToDate: "Die installierte Version ist aktuell.",
  integrity: "Prüfsumme",
  integrityHelp:
    "Die Prüfsumme bestätigt die Integrität des Downloads. Sie ist allein kein Nachweis der Herausgeberidentität.",
  platform: "Plattform",
  staged: "Vorbereitet",
  activateConfirmation:
    "Diese vorbereitete Version aktivieren? Der Webdienst wird neu gestartet; native Sessions bleiben erhalten.",
  rollbackConfirmation:
    "Zu dieser freigegebenen Version zurückwechseln? Aktuelle Nutzerdaten werden nicht durch alte Datenbanken ersetzt.",
  setupRequired:
    "Für automatische Aktivierung ist eine versionierte Installation erforderlich.",
  healthConfirmed: "Aktivierung und Zustandsprüfung bestätigt",
  rolledBack: "Vorherige Version wiederhergestellt",
  job: "Vorgang",
  jobStatuses: {
    running: "Läuft",
    succeeded: "Abgeschlossen",
    failed: "Fehlgeschlagen",
    interrupted: "Unterbrochen",
  },
  reconnecting: "Verbindung unterbrochen. Der bestehende Vorgang wird weiter beobachtet.",
  jobHelp: "Ein Neuladen startet den Vorgang nicht erneut.",
  observe: "Vorgang anzeigen",
};
export const diagnosticCopy = {
  account: "Account-Profil",
  project: "Projektverzeichnis",
  adapterSession: "Adapter-Session",
  remedies: {
    node: "Aktualisiere Node.js auf 22.23.4, 24.22.1, 26.12.1 oder neuer (Sicherheitskorrekturen).",
    platform: "Nutze einen unterstützten macOS- oder Linux-Rechner.",
    pty: "Installiere die Abhängigkeiten für diese Node-Laufzeit und Plattform neu.",
    tool: "Installiere das Tool oder korrigiere den PATH des Dienstes.",
    project:
      "Stelle den Projekt-Checkout auf diesem Rechner wieder her oder ordne ihn zu.",
    adapterReload: "Lade die Session neu, um den Protokolladapter neu zu starten.",
    adapterRestartFailed:
      "Lade die Session neu, um den Protokolladapter neu zu starten. Schlägt das erneut fehl, teste die Verbindung und prüfe ihre Adresse.",
  },
  checks: {
    platform: "Betriebssystem",
    node: "Node.js-Laufzeit",
    pty: "Natives Terminalmodul",
    tmux: "tmux",
    git: "Git",
    "cli.codex": "Codex CLI",
    "cli.claude": "Claude Code CLI",
    "cli.opencode": "OpenCode CLI",
    listener: "Web-Instanz",
    service: "Benutzerdienst",
    storage: "Datenverzeichnis und Zugriffsrechte",
    disk: "Freier Speicherplatz",
    "database.memory/memory.sqlite": "Memory-Datenbank",
    "database.pipeline-runs/runs.sqlite": "Pipeline-Datenbank",
    "database.audit/audit.sqlite": "Audit-Datenbank",
  },
};
export const backupCopy = {
  descriptions: {
    accounts: "Account-Profile",
    repositories: "Registrierte Repositorys",
    preferences: "Einstellungen",
    "pipeline-definitions": "Pipeline- und Profildefinitionen",
    memory: "Projektwissen",
    "pipeline-history": "Pipeline-Verlauf (verschlüsselt)",
    "unpinned-artifacts": "Nicht angeheftete Artefakte (verschlüsselt)",
    audit: "Aktivitätsprotokoll",
    chat: "Chat-Verläufe (verschlüsselt)",
    terminal: "Terminal-Aufnahmen (verschlüsselt)",
    "agentbus-history": "AgentBus-Verlauf (verschlüsselt)",
    assistants: "Agenten und ihre Einstellungen",
    "agent-history":
      "Chats, Kanalnachrichten, Arbeitsbereiche, Anhänge und geteilte Dateien der Agenten (verschlüsselt)",
    "sealed-agent-browser-profiles":
      "Browserprofile der Agenten mit Anmeldungen und Cookies (verschlüsselt, ohne Caches)",
    "Agent browser profiles (only in backups with a passphrase, then encrypted)":
      "Browserprofile der Agenten (nur in Sicherungen mit Passphrase, dann verschlüsselt)",
    "Agent browser caches": "Browser-Caches der Agenten",
    "Agent browser files that were in use":
      "Browserdateien der Agenten, die gerade in Benutzung waren",
    "Agent browser profiles (the agent list could not be read)":
      "Browserprofile der Agenten (die Agentenliste war nicht lesbar)",
    "sealed-assistant-credentials":
      "Agent-Zugangsdaten (versiegelt; nur auf diesem Host wiederherstellbar, bis Zugangsdaten oder Provider-Zugänge geändert werden)",
    "Assistant runtimes, package caches, update snapshots, TLS and backup keys":
      "Agent-Laufzeiten, Paket-Caches, Update-Sicherungen, TLS- und Sicherungsschlüssel",
    "Speech connection (Deepgram key and settings)":
      "Sprachverbindung (Deepgram-Key und Einstellungen)",
    "Agent data skipped: unfinished update state":
      "Agent-Daten übersprungen: unvollendeter Update-Zustand",
    "Agent workspaces too large": "Agent-Arbeitsbereiche zu groß",
    "Agent data too large": "Agent-Daten zu groß",
    "Unreadable agent runtime files": "Unlesbare Agent-Laufzeitdateien",
    "Assistant data in unsafe storage": "Agent-Daten in unsicherem Speicher",
    "Assistant links and files not owned by AgentPier":
      "Agent-Verknüpfungen und Dateien, die nicht AgentPier gehören",
    "provider-connections": "Provider-Zugänge",
    "encrypted-provider-credentials": "Keys der Provider-Zugänge (verschlüsselt)",
    "Managed SSH accesses, private keys and session assignments":
      "Verwaltete SSH-Zugänge, private Schlüssel und Session-Zuordnungen",
    "Workspace login credentials and browser sessions":
      "Anmeldedaten für Arbeitsbereiche und Browser-Sessions",
    "MCP client grants, OAuth credentials and start request capabilities":
      "MCP-Client-Freigaben, OAuth-Zugangsdaten und Berechtigungen für Startanfragen",
    "Shared native extensions, Agency agent files and their local installation records":
      "Gemeinsame native Erweiterungen, Agency-Agentendateien und ihre lokalen Installationsdaten",
    "encrypted-managed-profiles":
      "Anmeldungen, Einstellungen, Anweisungen, Skills und Agenten der verwalteten CLI-Profile (verschlüsselt)",
    "cli-histories":
      "CLI-Verläufe (verschlüsselt): Codex-Sessions und erzeugte Bilder, Claude-Code-Projekte, -Aufgaben und -Dateiversionen, OpenCode-Sessions",
    "CLI caches, logs, telemetry and files outside the profile allowlists":
      "CLI-Caches, -Protokolle, -Telemetrie und alle Dateien außerhalb der Profil-Positivlisten",
    "AgentPier and CLI histories": "AgentPier- und CLI-Verläufe",
    "Agent chats, channel messages, workspaces and attachments, pipeline history and unpinned artifacts":
      "Chats, Kanalnachrichten, Arbeitsbereiche und Anhänge der Agenten, Pipeline-Verlauf und nicht angeheftete Artefakte",
    "Agent chats, channel messages, workspaces and attachments, pipeline history and unpinned artifacts are only backed up in backups with a passphrase, and then encrypted":
      "Chats, Kanalnachrichten, Arbeitsbereiche und Anhänge der Agenten, Pipeline-Verlauf und nicht angeheftete Artefakte (setze eine Passphrase, um sie verschlüsselt zu sichern)",
    "AgentPier and CLI histories are only backed up in backups with a passphrase, and then encrypted":
      "AgentPier- und CLI-Verläufe (setze eine Passphrase, um sie verschlüsselt zu sichern)",
    // Older backups named only the CLI histories.
    "CLI conversation histories": "CLI-Verläufe",
    "Linked, shared or foreign files in CLI profiles":
      "Verknüpfte, geteilte oder fremde Dateien in CLI-Profilen",
    "encrypted-repository-credentials": "Repository-Zugangsdaten (verschlüsselt)",
    "External local CLI profiles and OS keychains":
      "Externe lokale CLI-Profile und Betriebssystem-Schlüsselbunde",
    "Repository checkouts, worktrees and uncommitted files":
      "Repository-Arbeitsverzeichnisse, Worktrees und nicht eingecheckte Dateien",
    "Platform-specific installed tool binaries and caches":
      "Installierte plattformspezifische Tools und Caches",
    "Live native processes, delivery channels, capabilities and subscriptions":
      "Laufende native Prozesse, Zustellkanäle, Berechtigungen und Benachrichtigungsanmeldungen",
    "File trash, file journals and transfer bytes":
      "Dateipapierkorb, Dateijournale und Übertragungsdaten",
    "Global atomicity across independent native writers":
      "Ein gemeinsamer Aufnahmezeitpunkt für alle unabhängig schreibenden nativen Prozesse",
    // Older backups declared the MCP server store as left out.
    "MCP servers for agents (definitions, values and bindings)":
      "MCP-Server für Agenten (Definitionen, Werte und Zuweisungen)",
    "mcp-servers":
      "MCP-Server für Agenten und CLIs (Definitionen und Zuweisungen, ohne Werte)",
    "encrypted-mcp-server-values":
      "Header- und Umgebungswerte der MCP-Server und Tokens in ihren Adressen (verschlüsselt)",
    "MCP server OAuth logins": "OAuth-Anmeldungen der MCP-Server",
    users: "Benutzer und ihre Einstellungen (ohne Passwörter)",
    "encrypted-user-passwords": "Passwörter der Benutzer (verschlüsselt)",
    "User passwords (the owner sets new ones after a restore)":
      "Passwörter der Benutzer (nach einer Wiederherstellung vergibst du neue)",
    "sealed-secrets": "Geheimnisse für Agenten und Sessions (verschlüsselt)",
    "Secrets (only in backups with a passphrase, then encrypted)":
      "Geheimnisse (nur in Sicherungen mit Passphrase, dann verschlüsselt)",
    "MCP server header and environment values and address tokens":
      "Header- und Umgebungswerte der MCP-Server und Tokens in ihren Adressen",
    "Files removed while the backup was written":
      "Dateien, die während der Sicherung gelöscht wurden",
    "Files that changed while the backup was written":
      "Dateien, die sich während der Sicherung geändert haben (nur zeilenbasierte Verläufe werden wiederhergestellt)",
    "CLI histories are only backed up in backups with a passphrase, and then encrypted":
      "CLI-Verläufe werden nur in Backups mit Passphrase und verschlüsselt gesichert",
    "Managed native configuration and credentials":
      "Verwaltete native Konfiguration und Zugangsdaten",
    "coordinated-application-snapshot; independent-native-captures":
      "Anwendungsdaten werden gemeinsam aufgenommen. Native Aufnahmen entstehen unabhängig voneinander.",
    "per-component-snapshots; independent-native-captures":
      "Jeder Bestandteil und jede native Aufnahme wird unabhängig aufgenommen.",
  },
};
export const importedHistoryCopy = {
  title: "Importierter AgentBus-Verlauf",
  readOnly: "Verlauf aus Sicherung; Nachrichten werden nicht erneut zugestellt.",
  project: "Importiertes Projekt",
  choose: "Projekt wählen",
  loading: "Verlauf wird geladen …",
  truncated: "Der gespeicherte Verlauf wurde gekürzt.",
  read: "Gelesen",
  pending: "Zum Sicherungszeitpunkt noch ausstehend",
  unknown: "Unbekannt",
  empty: "Keine importierten Nachrichten vorhanden.",
};
