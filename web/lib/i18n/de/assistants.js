import { assistantChannelCopy } from "./assistant-channel.js";
import { assistantTeamCopy } from "./assistant-team.js";
export const assistantCopy = {
  updates: {
    title: "OpenClaw-Updates",
    description:
      "Bereite die von AgentPier geprüfte Version vor und aktiviere sie anschließend mit Datensicherung und Wiederherstellung.",
    current: "Aktuelle Version",
    target: "Zielversion",
    stage: "Update vorbereiten",
    activate: "Update aktivieren",
    recover: "Wiederherstellung fortsetzen",
    phase: "Update-Status",
    blocked:
      "Aktive oder ungeklärte Arbeit verhindert die Aktivierung. Prüfe Chats, Aufträge und Zustellungen.",
    phases: {
      idle: "Bereit",
      staging: "Wird vorbereitet",
      staged: "Vorbereitet",
      draining: "Arbeit wird abgeschlossen",
      snapshotting: "Datensicherung läuft",
      activating: "Wird aktiviert",
      validating: "Wird geprüft",
      committed: "Aktiviert; Betrieb wird fortgesetzt",
      complete: "Update abgeschlossen",
      rolling_back: "Vorherige Version wird wiederhergestellt",
      rollback_committed: "Wiederhergestellt; Betrieb wird fortgesetzt",
      rolled_back: "Vorherige Version wieder aktiv",
      recovery_required: "Wiederherstellung erforderlich",
    },
    diagnostics: {
      UPDATE_STAGE_FAILED:
        "Vorbereitung fehlgeschlagen. Die aktive Version bleibt erhalten.",
      UPDATE_STAGE_INTERRUPTED: "Vorbereitung wurde unterbrochen. Erneut vorbereiten.",
      UPDATE_BLOCKED: "Aktive oder ungeklärte Arbeit blockiert das Update.",
      UPDATE_ROLLED_BACK:
        "Aktivierung fehlgeschlagen; vorherige Version wiederhergestellt.",
      UPDATE_RECOVERY_REQUIRED:
        "Wiederherstellung erforderlich. Der Dienst bleibt angehalten.",
      UPDATE_RESUME_REQUIRED:
        "Der Zustand wurde übernommen. Fortsetzen ohne Zurücksetzen späterer Arbeit.",
      UPDATE_ROLLED_BACK_LOGIN_REQUIRED:
        "Aktivierung fehlgeschlagen; vorherige Version wiederhergestellt. Seit der Datensicherung widerrufene Zugangsdaten wurden nicht wiederhergestellt. Melde dich bei Bedarf erneut an.",
      INSUFFICIENT_SPACE:
        "Nicht genug freier Speicherplatz für die Datensicherung. Gib Speicher frei und aktiviere erneut.",
      RUNTIME_BUSY:
        "Ein anderer AgentPier-Prozess installiert gerade OpenClaw. Versuche es später erneut.",
      SNAPSHOT_FAILED:
        "Die Datensicherung konnte die unten genannte Datei nicht aufnehmen. Die vorherige Version bleibt aktiv.",
    },
    upToDate: "Die geprüfte Version ist bereits aktiv.",
    affected: (count, members = 0) =>
      `${count} ${count === 1 ? "Agent" : "Agenten"} betroffen${members ? ` (+${members} ${members === 1 ? "Teammitglied" : "Teammitglieder"})` : ""}`,
  },

  personal: {
    memoryGroup: "Gedächtnis & Erinnerungen",
    webGroup: "Web & Dokumente",
    enableWebSearch: "Im Web suchen",
    enableWebFetch: "Webseiten lesen",
    enableBrowser: "Einen Browser nutzen",
    enableDocuments: "Bilder lesen",
    enableCreateImages: "Bilder erstellen",
    memoryDescription: "Führt eigene Notizen über Unterhaltungen hinweg.",
    remindersDescription: "Sendet Erinnerungen und führt Zeitpläne über Telegram aus.",
    webSearchDescription: "Recherchiert mit dem in den Zugängen gewählten Suchanbieter.",
    webFetchDescription: "Öffnet eine Webadresse und liest den Text der Seite.",
    browserDescription:
      "Steuert ein eigenes, dauerhaftes Browserprofil für Seiten, die Klicken oder Anmelden erfordern.",
    documentsDescription:
      "Betrachtet Bilder in seinem Arbeitsordner. Braucht ein Modell, das Bilder annimmt.",
    createImagesDescription:
      "Erstellt und bearbeitet Bilder mit deinem ChatGPT-Konto (gpt-image-2) und gibt sie dir im Chat.",
    imagesUnavailable:
      "Verbinde unter Accounts › ChatGPT für Agenten ein ChatGPT-Konto, um Bilder zu erstellen.",
    browserUnavailable:
      "Auf diesem Rechner wurde kein unterstützter Browser gefunden. Installiere Chrome, Brave, Edge oder Chromium, um dies zu nutzen.",
    searchUnavailable:
      "Die Websuche ist nicht eingerichtet. Wähle in den Zugängen einen Anbieter und hinterlege seinen Schlüssel.",
    availableAfterSaving: "Nach dem Speichern verfügbar",
    webHint:
      "Webseiten können Anweisungen enthalten, die den Agenten in die Irre führen sollen. Schalte das nur für Agenten ein, deren übrige Tools du dem anvertrauen würdest.",
    restartTitle: "Agentendienst neu starten?",
    restartBody:
      "Diese Änderung startet den Dienst der Agenten kurz neu. Laufende Arbeit wird nicht unterbrochen: Ist ein Agent beschäftigt, wird das Speichern abgelehnt und nichts ändert sich.",
    restartAffected: (names, members = 0) =>
      `Kurz nicht erreichbar: ${names || "keine Agenten"}${members ? ` (+${members} Teammitglied${members === 1 ? "" : "er"})` : ""}`,
    restartConfirm: "Speichern und neu starten",
    restartCancel: "Abbrechen",
    capabilities: "Persönliche Assistenz",
    enableMemory: "Informationen merken",
    enableReminders: "Erinnerungen und Routinen erlauben",
    capabilityHint:
      "Jeder Agent hat eigene Notizen. Beim Abschalten der Erinnerungen werden seine Zeitpläne pausiert.",
    memory: "Gedächtnis",
    memoryHint:
      "Verwalte dauerhafte Notizen und Vorlieben dieses Agenten oder durchsuche seine gespeicherten Notizen.",
    noteType: "Notizart",
    facts: "Dauerhafte Notizen",
    preferences: "Vorlieben",
    agentNotes: "Notizen des Agenten",
    agentNotesHint:
      "Diese Notizen schreibt der Agent selbst. Sie werden hier nur angezeigt; bitte den Agenten, sie zu ändern.",
    notes: "Gespeicherte Notizen",
    saveNotes: "Notizen speichern",
    clearNotes: "Entwurf leeren",
    reload: "Notizen neu laden",
    clearHint:
      "Speichere eine leere Notiz, um sie zu leeren. Nachrichten im Chatverlauf bleiben erhalten.",
    searchMemory: "Gedächtnis durchsuchen",
    search: "Suchen",
    noResults: "Keine passenden Notizen gefunden.",
    reminders: "Erinnerungen",
    remindersHint:
      "Erhalte einmalige oder tägliche Erinnerungen im Chat dieses Agenten, mit Push-Benachrichtigung. Du kannst Erinnerungen auch im Chat beauftragen.",
    reminderName: "Name der Erinnerung",
    reminderText: "Erinnerungstext",
    repeat: "Wiederholung",
    once: "Einmalig",
    daily: "Täglich",
    when: "Datum und Uhrzeit",
    time: "Uhrzeit",
    timezone: "Zeitzone",
    localTime: (zone) => `Ortszeit (${zone})`,
    createReminder: "Erinnerung erstellen",
    noReminders: "Noch keine Erinnerungen.",
    unknownReminder: "Erinnerung wartet auf Abgleich",
    pauseReminder: "Erinnerung pausieren",
    resumeReminder: "Erinnerung fortsetzen",
    removeReminder: "Erinnerung entfernen",
    reviewReminder: "Als geprüft markieren",
    reviewReminderHint:
      "Ob diese Erinnerung angelegt wurde, ist unklar. Sie wird nicht automatisch erneut angelegt.",
    history: "Ausführungsverlauf",
    noRuns: "Noch keine Ausführungen.",
    nextRun: (time) => `Nächste Ausführung: ${time}`,
    telegramDelivery: (state) => `Telegram: ${state}`,
    invalidTime: "Wähle ein gültiges Datum mit Uhrzeit in der Zukunft.",
    states: {
      active: "Aktiv",
      paused: "Pausiert",
      completed: "Abgeschlossen",
      unknown: "Ausgang unbekannt – vor erneutem Versuch prüfen",
      failed: "Fehlgeschlagen",
      removed: "Entfernt",
      succeeded: "Abgeschlossen",
      ok: "Abgeschlossen",
      error: "Fehlgeschlagen",
      skipped: "Übersprungen",
    },
  },
  team: assistantTeamCopy,
  remoteChanged: (fields) =>
    `Dieser Agent wurde auf dem Server geändert, während du ihn bearbeitet hast (${fields}). Deine Änderungen bleiben erhalten; lade neu, um stattdessen die aktuellen Werte zu verwenden.`,
  reloadLatest: "Aktuelle Werte laden",
  sidebarLabel: (name, detail, status) => `${name}, ${detail}, ${status}`,
  runtimeDiagnostics: {
    RESTART_LIMIT:
      "Der Agentendienst startet nach wiederholten Fehlern nicht mehr automatisch neu. Starte ihn manuell neu.",
    WRITE_GUARD_PENDING:
      "Der Agentendienst läuft, aber Gedächtnis-Schreibzugriffe warten auf seinen Schreibschutz. Bis dahin können Agenten das Gedächtnis nur lesen.",
  },
  conversationDiagnostics: {
    SESSION_UNAVAILABLE:
      "Die Session dieses Chats ist im Agentendienst gerade nicht verfügbar. Neue Antworten können sich verzögern; AgentPier versucht es automatisch erneut.",
  },
  conversation: "Unterhaltung",
  settingsTab: "Einstellungen",
  messagePlaceholder: "Nachricht an deinen Agenten …",
  webSearch: {
    title: "Websuche",
    description:
      "Der Suchanbieter, den Agenten bei eingeschalteter Websuche nutzen. Änderungen können den Agentendienst neu starten.",
    provider: "Suchanbieter",
    duckduckgo: "DuckDuckGo (kein Schlüssel nötig)",
    perplexity: "Perplexity (über eine OpenRouter-Verbindung)",
    brave: "Brave Search (API-Schlüssel)",
    connection: "OpenRouter-Verbindung",
    noConnection: "Verbindung wählen",
    noConnections:
      "Lege unter Modell-Zugänge eine OpenRouter-Verbindung an, um Perplexity zu nutzen.",
    braveKey: "Brave-API-Schlüssel",
    braveKeyStored: "Schlüssel gespeichert",
    braveKeyMissing: "Kein Schlüssel gespeichert",
    removeKey: "Brave-Schlüssel entfernen",
    ready: "Bereit",
    notConfigured:
      "Nicht eingerichtet: Agenten können das Web erst durchsuchen, wenn dies vollständig ist.",
    save: "Sucheinstellungen speichern",
    saving: "Speichert …",
  },
  speech: {
    title: "Spracherkennung",
    description:
      "Ein zentraler Deepgram-Zugang für Sprachnachrichten deiner Agenten und das Diktat in den Chats. Audio wird zur Transkription an Deepgram gesendet.",
    saved: "Schlüssel gespeichert",
    missing: "Kein Schlüssel eingerichtet",
    key: "Deepgram-API-Schlüssel",
    model: "Erkennungsmodell",
    language: "Erkennungssprache",
    auto: "Automatisch erkennen",
    german: "Deutsch",
    english: "Englisch",
    save: "Spracheinstellungen speichern",
    remove: "Sprachschlüssel entfernen",
    dictationSend: "Diktierte Nachrichten sofort senden",
    dictationSendHint:
      "Aus: Der diktierte Text bleibt im Nachrichtenfeld, damit du ihn vor dem Senden bearbeiten kannst.",
  },
  channel: assistantChannelCopy,
  accountsTitle: "ChatGPT für Agenten",
  accountsDescription:
    "Verbinde dein ChatGPT-Konto und wähle es in den Einstellungen eines Agenten aus.",
  accountsOffline: "Starte den Agentendienst, um diese Verbindungen zu verwalten.",
  accountConnect: "ChatGPT verbinden",
  accountCheck: "Verbindung prüfen",
  accountDisconnect: "Abmelden",
  accountVerified: "Verbindung bestätigt",
  accountCheckFailed:
    "Verbindung konnte nicht bestätigt werden. Versuche es erneut oder melde dich neu an.",
  loginInstructions: "Gib diesen Code auf der OpenAI-Anmeldeseite ein.",
  loginOpen: "Anmeldeseite öffnen",
  loginPage: "Anmeldeseite:",
  loginCancel: "Anmeldung abbrechen",
  loginStatus: {
    starting: "Anmeldung wird gestartet …",
    awaiting_user: "Warte auf deine Anmeldung",
    completed: "ChatGPT verbunden",
    cancelled: "Anmeldung abgebrochen",
    failed: "Anmeldung fehlgeschlagen. Bitte versuche es erneut.",
  },
  loginFailure: {
    LOGIN_UNAVAILABLE:
      "Der Agentendienst bietet die ChatGPT-Anmeldung derzeit nicht an. Starte den Agentendienst neu und versuche es erneut.",
    UNSUPPORTED_LOGIN_STEP:
      "Die Anmeldung verlangte einen Schritt, den AgentPier nicht unterstützt.",
    LOGIN_EXPIRED: "Der Code ist abgelaufen, bevor die Anmeldung abgeschlossen wurde.",
    CONNECTION_LOST: "Die Verbindung zum Agentendienst wurde unterbrochen.",
    LOGIN_FAILED:
      "Der Agentendienst hat die Anmeldung mit einem Fehler beendet. Details stehen im AgentPier-Protokoll.",
  },
  accountStatus: {
    ok: "Verbunden",
    expiring: "Verbunden · Erneuerung steht bevor",
    expired: "Abgelaufen · Verbindung für einen Erneuerungsversuch prüfen",
    missing: "Anmeldung erforderlich",
    invalid: "Anmeldung erforderlich",
    unknown: "Status unbekannt",
    offline: "Dienst offline",
  },
  title: "Agenten",
  chats: "Agenten-Chats",
  agentsGroup: "Agenten",
  sidebarOffline:
    "Verbindung unterbrochen. Angezeigt werden die zuletzt bekannten Agenten.",
  feature: {
    title: "Agenten aktivieren",
    description:
      "Agenten werden von OpenClaw verwaltet. Solange dies aus ist, zeigt AgentPier keine Agenten-Navigation und keine Account-Bereiche und startet auf diesem Host keine Agentenverbindungen oder Hintergrundarbeit.",
    saving: "Wird gespeichert …",
    diagnostic: "Agenten-Diagnose",
    problem: (code) => `Agenten meldeten ein Problem (${code}).`,
    errors: {
      FEATURE_CHECK_FAILED:
        "Es konnte nicht geprüft werden, ob Agenten aktiv sind. AgentPier versucht es weiter.",
      ASSISTANT_STORAGE_UNSAFE:
        "Der Agenten-Datenordner ist kein normaler, AgentPier gehörender Ordner. Korrigiere den Besitzer oder entferne ihn und versuche es erneut.",
      ASSISTANT_INITIALIZATION_FAILED:
        "Agenten konnten nicht gestartet werden. Prüfe die Diagnose und versuche es erneut.",
    },
    offTitle: "Agenten sind aus",
    offDescription:
      "Aktiviere Agenten in den Einstellungen, um Agenten anzulegen und mit ihnen zu chatten.",
    openSettings: "Agenten-Einstellungen öffnen",
  },
  showMembers: (count) => `Teammitglieder anzeigen (${count})`,
  hideMembers: (count) => `Teammitglieder ausblenden (${count})`,
  description: "Dauerhafte Agenten für deine Ideen und Alltagsplanung.",
  create: "Neuer Agent",
  empty: "Erstelle deinen ersten Agenten und beginne eine Unterhaltung.",
  name: "Name",
  instructions: "Anweisungen",
  generatedInstructions: "Von der Teamleitung erstellt – vor der Verwendung prüfen.",
  confirmInstructions: "Als geprüft markieren",
  connection: "Provider-Zugang",
  model: "Modell-ID",
  modelChoice: "Modell",
  chooseModel: "Modell auswählen",
  noMatchingModels: "Keine passenden Modelle gefunden.",
  customModel: "Eigene Modell-ID …",
  refreshAccountModels: "Modelle aktualisieren",
  accountModelsLoading: "ChatGPT-Modelle werden geladen …",
  accountModelsStale:
    "Die ChatGPT-Modellliste konnte nicht aktualisiert werden und ist eventuell veraltet. Eine eigene Modell-ID bleibt möglich.",
  accountModelsUnverified:
    "Das Gateway hat diese Liste mit einem anderen ChatGPT-Konto geprüft. Manche Modelle funktionieren mit diesem Konto eventuell nicht.",
  accountModelsFailed:
    "Die ChatGPT-Modellliste konnte nicht geladen werden. Gib eine Modell-ID ein oder versuche es später erneut.",
  chooseConnection: "Zugang auswählen",
  connections: "Zugänge verwalten",
  noConnections: "Verbinde unter Accounts ChatGPT oder OpenRouter, um zu starten.",
  save: "Agent speichern",
  settings: "Agenten-Einstellungen",
  connectionUse: {
    agents: (names) =>
      `${new Intl.ListFormat("de", { type: "conjunction" }).format(names)} ${names.length === 1 ? "nutzt" : "nutzen"} diesen Provider-Zugang. ${names.length === 1 ? "Er funktioniert" : "Sie funktionieren"} erst wieder, wenn du ${names.length === 1 ? "ihm" : "ihnen"} einen anderen Provider-Zugang zuweist.`,
    members: (count) =>
      `Außerdem ${count === 1 ? "nutzt ein temporäres Teammitglied" : `nutzen ${count} temporäre Teammitglieder`} diesen Provider-Zugang.`,
  },
  connectionMissingHint:
    "Der Provider-Zugang dieses Agenten wurde gelöscht. Wähle in den Agent-Einstellungen einen anderen Zugang.",
  chat: "Chat öffnen",
  revisions: (saved, applied) =>
    `Gespeicherte Revision: ${saved} · Angewendete Revision: ${applied}`,
  pendingConfig: "Gespeicherte Änderungen gelten ab der nächsten Nachricht.",
  pendingConfigShort: "Gilt ab der nächsten Nachricht.",
  message: "Nachricht",
  send: "Senden",
  stop: "Antwort stoppen",
  stopShort: "Stoppen",
  // A message written while the agent works waits above the composer until it is done.
  queued: {
    send: "Senden, wenn fertig",
    notice: (name) => `Wird gesendet, sobald ${name} fertig ist`,
    files: (count) => (count === 1 ? "1 Datei" : `${count} Dateien`),
    edit: "Bearbeiten",
    editLabel: "Wartende Nachricht bearbeiten",
    label: "Wartende Nachricht",
    sending: "Wird jetzt gesendet …",
    retrying: (name) =>
      `Noch nicht gesendet: AgentPier versucht weiter, sie an ${name} zu senden`,
    blocked: (name) =>
      `Noch nicht gesendet: ${name} kann gerade keine Nachrichten annehmen`,
    failed: (reason) => `Nicht gesendet: ${reason}`,
    unknownError: "Der Agent hat sie nicht angenommen.",
  },
  showApprovals: "Anzeigen",
  memberCount: (count) => (count === 1 ? "1 Mitglied" : `${count} Mitglieder`),
  options: "Optionen",
  optionsClose: "Optionen schließen",
  backToChat: "Zurück zur Unterhaltung",
  you: "Du",
  // Under a message longer than the chat can load (65,536 characters).
  messageCut: "Gekürzt: Der Rest dieser Nachricht ist zu lang für die Anzeige.",
  // Under a long message whose rest the chat has not loaded yet.
  messagePartial: "Der Rest dieser Nachricht wird gleich geladen.",
  // The meta line under a message that reached the agent through Telegram.
  telegramSource: {
    via: "über Telegram",
    // The meta line under the bubble, and what screen readers hear instead.
    at: (via, time) => `${via} · ${time}`,
    spokenAt: (via, time) => `${via}, ${time}`,
  },
  earlier: "Ältere Nachrichten",
  emptyChat: "Woran möchtest du arbeiten?",
  loading: "Wird geladen …",
  unavailable: "Dieser Agent ist nicht verfügbar.",
  runtimeLink: "Agentendienst-Einstellungen",
  runtime: "Agentendienst",
  runtimeDescription:
    "Ein verwalteter OpenClaw-Dienst führt deine Agenten auf diesem Rechner aus.",
  enable: "Dienst aktivieren",
  start: "Dienst starten",
  stopService: "Dienst stoppen",
  restart: "Dienst neu starten",
  serviceState: "Dienst",
  syncState: "Synchronisierung",
  details: "Technische Details",
  version: "Runtime-Version",
  diagnostic: "Diagnosecode",
  disconnected:
    "Verbindung unterbrochen. Dein Entwurf bleibt erhalten; der Verlauf wird nach der Verbindung aktualisiert.",
  stale: "Gespeicherter Verlauf, während der Dienst nicht erreichbar ist.",
  uncertain:
    "Die vorherige Anfrage wurde möglicherweise ausgeführt. Ihr Ausgang ist noch unklar; sie wird nicht automatisch erneut gesendet.",
  recover: "Dienst neu starten und Ungewissheit bestätigen",
  // Ein gesendeter Turn, dessen Annahme der Dienst noch nicht bestätigt hat.
  unconfirmed:
    "Bestätigung vom Agenten-Dienst steht aus. Die Anfrage läuft vermutlich bereits; sie wird nicht erneut gesendet.",
  recoverNotice:
    "Prüfe zuerst den Verlauf. Der Dienst wird neu gestartet und der Chat freigegeben; bisherige Auswirkungen bleiben unklar. Es wird nichts automatisch erneut gesendet.",
  reviewed:
    "Unklaren Ausgang zur Kenntnis genommen. Prüfe bisherige Auswirkungen, bevor du diese Anfrage wiederholst.",
  pending: "Anfrage empfangen. Warte auf den Agenten.",
  error: "Die Agenten-Aktion konnte nicht abgeschlossen werden.",
  retry: "Aktualisieren",
  future: "Telegram, Sprache und Teams folgen als nächste Integrationsschritte.",
  status: {
    connectionMissing: "Zugang fehlt",
    disabled: "Gestoppt",
    installing: "Wird installiert",
    starting: "Startet",
    ready: "Bereit",
    reconnecting: "Verbindet erneut",
    stopping: "Wird gestoppt",
    failed: "Fehlgeschlagen",
    current: "Aktuell",
    reconciling: "Status wird geprüft",
    stale: "Nicht synchronisiert",
    pending: "Ausstehend",
    accepted: "Angenommen",
    running: "Arbeitet",
    completed: "Abgeschlossen",
    interrupted: "Unterbrochen",
    uncertain: "Ausgang unklar",
    unconfirmed: "Bestätigung ausstehend",
    cancelled: "Abgebrochen",
    compacting: "Fasst Verlauf zusammen",
  },
  // Ein Lauf, der zuerst seinen langen Verlauf kürzt (Server compactions.js).
  compaction: {
    running:
      "Fasst den bisherigen Verlauf zusammen – bei langen Chats kann das ein paar Minuten dauern.",
    note: (before, after) =>
      `Ältere Nachrichten wurden zusammengefasst (etwa ${before}k → ${after}k Tokens).`,
    noteWithoutTokens: "Ältere Nachrichten wurden zusammengefasst.",
  },
  teamActive: {
    working: "Team arbeitet",
    awaiting: "Team wartet auf Freigabe",
  },
};
