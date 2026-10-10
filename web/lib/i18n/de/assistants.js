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
    capabilities: "Persönliche Assistenz",
    enableMemory: "Informationen merken",
    enableReminders: "Telegram-Erinnerungen erlauben",
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
      "Erhalte einmalige oder tägliche Erinnerungen im verbundenen Telegram-Chat dieses Agenten. Du kannst Erinnerungen auch im Chat beauftragen.",
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
  team: {
    modelChanged: "Modell: seit Erstellung geändert",
    modelOriginal: "Modell: wie bei Erstellung",
    instructionsChanged: "Anweisungen: seit Erstellung geändert",
    instructionsOriginal: "Anweisungen: wie bei Erstellung",
    setupUnknown:
      "Die Einrichtung könnte bereits erfolgt sein. Prüfe den Zustand, bevor du die Unklarheit bestätigst. Der Dienst wird neu gestartet; das Mitglied wird als fehlgeschlagen abgeschlossen und nicht ersetzt.",
    title: "Teams",
    settings: "Team-Einstellungen",
    memberSettings: "Team-Mitglied",
    allowOnce: "Ein Team für diese Nachricht erlauben",
    startedBecause: (quote) => `Gestartet, weil du geschrieben hast: „${quote}“`,
    approvalHint:
      "Dieses Team wartet auf deine Freigabe. Die Mitglieder erhalten eigene Chats.",
    approve: "Team freigeben",
    decline: "Team ablehnen",
    stopTeam: "Team stoppen",
    stopMember: "Mitglied stoppen",
    archive: "Archivieren",
    restore: "Wiederherstellen",
    showArchived: "Archivierte Teams anzeigen",
    autonomous: "Teams ohne erneute Rückfrage erlauben",
    permissionHint:
      "Standardmäßig fragt der Agent nach. /team oder die Nachrichtenoption erlaubt ein Team für einen Auftrag.",
    maxMembers: "Maximale Teamgröße",
    timeout: "Laufzeit pro Mitglied (Minuten)",
    capacity: "Gleichzeitig aktive Mitglieder auf diesem Host",
    concurrentHint:
      "Alle Mitglieder dürfen gleichzeitig arbeiten, solange die gemeinsame Kapazität reicht.",
    save: "Team-Einstellungen speichern",
    permanent: "Dauerhafter Agent",
    taskBound: "Auftragsgebundenes Mitglied",
    independent:
      "Modell und Anweisungen sind eine unabhängige Kopie. Änderungen am Elternagenten überschreiben sie nicht. Änderungen sind nach Abschluss möglich.",
    promote: "Als dauerhaften Agenten behalten",
    states: {
      partial: "Teilweise erfolgreich",
      awaiting_approval: "Wartet auf Freigabe",
      approved: "Freigegeben",
      queued: "Wartet auf Kapazität",
      provisioning: "Wird eingerichtet",
      provisioning_uncertain: "Einrichtung unklar",
      ready: "Bereit",
      admitting: "Wird gestartet",
      running: "Arbeitet",
      stopping: "Wird gestoppt",
      uncertain: "Ergebnis unklar",
      completed: "Abgeschlossen",
      failed: "Fehlgeschlagen",
      cancelled: "Abgebrochen",
      declined: "Abgelehnt",
    },
    internalTurns: {
      "team-result": "Team-Ergebnisse eingegangen. Der Agent fasst sie zusammen.",
      "coding-result": "Ergebnis eines Coding-Laufs eingegangen.",
    },
    inherited: (name, revision) =>
      `Erstellt von ${name} · übernommene Revision ${revision}`,
  },
  navigation: "Agenten-Ansichten",
  settingsSections: "Einstellungsbereiche",
  sections: {
    profile: "Profil",
    access: "Zugriff",
    memory: "Gedächtnis",
    reminders: "Erinnerungen",
    routines: "Routinen",
    team: "Team",
    telegram: "Telegram",
  },
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
      "Die Sitzung dieses Chats ist im Agentendienst gerade nicht verfügbar. Neue Antworten können sich verzögern; AgentPier versucht es automatisch erneut.",
  },
  conversation: "Unterhaltung",
  settingsTab: "Einstellungen",
  messagePlaceholder: "Nachricht an deinen Agenten …",
  speech: {
    title: "Spracherkennung",
    description:
      "Ein zentraler Deepgram-Zugang für Sprachnachrichten deiner Agenten. Audio wird zur Transkription an Deepgram gesendet.",
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
  },
  channel: {
    language: "Sprache der Telegram-Hinweise",
    languageDe: "Deutsch",
    languageEn: "Englisch",
    languageHint:
      "Hinweise von AgentPier (Freigaben, Team-Updates, Links) verwenden diese Sprache. Sie wird beim ersten Verbinden aus diesem Browser übernommen; erneutes Koppeln behält Ihre Wahl. Bereits eingereihte Hinweise behalten ihren Text; die Antworten des Agenten werden nicht übersetzt.",
    appUrl: "AgentPier-Adresse für Links",
    appUrlHint:
      "Telegram-Hinweise verlinken auf diese Adresse. Sie wird beim Verbinden oder Koppeln aus diesem Browser übernommen; leer lassen, um Hinweise ohne Links zu senden.",
    saveAppUrl: "Adresse speichern",
    ignored: (privateCount, groupCount) =>
      `Ignorierte Nachrichten: ${privateCount} aus anderen privaten Chats, ${groupCount} aus Gruppen.`,
    teamNotification: "Team-Benachrichtigung",
    connected: (chatId) => `Mit privatem Chat ${chatId} verbunden`,
    description:
      "Nutze den gemeinsamen Chat dieses Agenten aus deinem privaten Telegram-Chat. Antworten auf Telegram-Nachrichten kommen in Telegram an.",
    paused: "Pausiert oder wartet auf Kopplung",
    disconnected: "Getrennt",
    failed: "Die Kanal-Aktion konnte nicht abgeschlossen werden.",
    token: "Telegram-Bot-Token",
    botHint:
      "Erstelle mit BotFather einen eigenen Bot. Wird er bereits von einem anderen Dienst genutzt, trenne ihn dort zuerst.",
    connect: "Telegram verbinden",
    pairHint:
      "Öffne den Link und sende die Startnachricht, um deinen privaten Chat zu koppeln. Der Code gilt zehn Minuten.",
    pair: "Meinen privaten Chat koppeln",
    newPair: "Neuen Kopplungscode erstellen",
    pause: "Telegram pausieren",
    resume: "Telegram fortsetzen",
    disconnect: "Bot trennen",
    speechLink: "Deepgram unter Konten verwalten",
    activity: "Telegram-Aktivität",
    voice: "Sprachnachricht",
    retry: "Erneut versuchen",
    review: "Ohne erneuten Versand bestätigen",
    openChat: "Agenten-Chat prüfen",
    title: "Telegram",
    inProgress:
      "Noch in Bearbeitung. Hier erscheint eine Prüfaktion, sobald deine Entscheidung nötig ist.",
    states: {
      partial: "Teilweise erfolgreich",
      queued: "In der Warteschlange",
      voice_pending: "Wartet auf Transkription",
      transcribing: "Wird transkribiert",
      transcription_failed: "Transkription fehlgeschlagen",
      dispatching: "Agent wird gestartet",
      running: "Agent arbeitet",
      model_uncertain: "Ausgang der Anfrage unklar",
      model_reviewed: "Ausgang im Chat geprüft",
      outbound: "Wartet auf Versand",
      delivering: "Antwort wird gesendet",
      delivered: "Zugestellt",
      delivery_failed: "Zustellung fehlgeschlagen",
      delivery_uncertain: "Ausgang der Zustellung unklar",
      reply_unavailable: "Antwort ohne Text",
      failed: "Fehlgeschlagen",
      cancelled: "Abgebrochen",
      reviewed: "Zur Kenntnis genommen",
    },
    diagnostics: {
      CHANNEL_DESTINATION_CHANGED:
        "Die Chat-Verknüpfung hat sich geändert. Prüfe diesen Eingang, bevor es weitergeht.",
      TELEGRAM_CONFLICT:
        "Ein anderer Dienst ruft diesen Bot ab. Stoppe ihn vor dem Fortsetzen.",
      TELEGRAM_WEBHOOK:
        "Für diesen Bot ist bereits ein Webhook eingerichtet. Trenne zuerst die andere Integration.",
      TELEGRAM_UNAVAILABLE: "Telegram ist gerade nicht erreichbar.",
      TELEGRAM_REJECTED:
        "Telegram hat die Anfrage abgewiesen. Prüfe die Bot-Verbindung und ob der Chat Nachrichten zulässt.",
      TELEGRAM_RATE_LIMIT:
        "Telegram verlangt eine Pause. Der Versand wird nach der Wartezeit fortgesetzt.",
      MEDIA_TOO_LARGE: "Sprachnachrichten sind auf 10 MB und zehn Minuten begrenzt.",
      MEDIA_UNSUPPORTED: "Unterstützt werden Text und Ogg-Sprachnachrichten.",
      VOICE_TOO_LONG:
        "Die Sprachnachricht war zu lang und wurde vor dem Herunterladen abgelehnt.",
      TRANSCRIPTION_REJECTED:
        "Deepgram hat die Audiodatei abgelehnt. Die Antwort von Deepgram steht darunter.",
      TRANSCRIPTION_QUOTA:
        "Das Deepgram-Guthaben oder Kontingent ist erschöpft. Prüfe dein Deepgram-Konto.",
      TRANSCRIPTION_RATE_LIMITED:
        "Deepgram hat nach mehreren Versuchen weiterhin eine Pause verlangt. Du kannst die Transkription später erneut versuchen.",
      MEDIA_DOWNLOAD: "Die Sprachnachricht konnte nicht heruntergeladen werden.",
      SPEECH_NOT_CONFIGURED: "Richte vor der Transkription Deepgram unter Konten ein.",
      SPEECH_AUTH:
        "Deepgram hat den Schlüssel abgewiesen. Aktualisiere ihn unter Konten.",
      TRANSCRIPTION_EMPTY: "Es wurde keine Sprache erkannt.",
      TRANSCRIPTION_FAILED:
        "Transkription fehlgeschlagen. Du kannst sie gezielt erneut versuchen.",
      TRANSCRIPTION_INTERRUPTED:
        "Die Transkription wurde unterbrochen und nicht automatisch wiederholt.",
      MODEL_REQUEST_FAILED:
        "Die Agenten-Anfrage ist fehlgeschlagen oder wurde abgebrochen.",
      MODEL_OUTCOME_UNKNOWN:
        "Prüfe und kläre zuerst die ungewisse Anfrage im Agenten-Chat.",
      REPLY_UNAVAILABLE: "Warte auf die bestätigte Antwort zu dieser Anfrage.",
      REPLY_TOO_LARGE:
        "Die Antwort überschreitet das Versandlimit dieser Telegram-Anbindung.",
      REPLY_WITHOUT_TEXT:
        "Der Agent hat ohne Textantwort geendet. Prüfe sie im Agenten-Chat; an Telegram wurde nichts gesendet.",
      CHANNEL_QUEUE_FULL:
        "Die Telegram-Warteschlange ist voll. Neue Nachrichten werden abgelehnt, bis wartende Eingänge verarbeitet oder geprüft sind.",
      DECISION_FAILED:
        "Eine Entscheidung aus Telegram konnte nicht gespeichert werden. Entscheide stattdessen in AgentPier.",
      MODEL_OUTCOME_REVIEWED:
        "Die ungewisse Anfrage wurde im Agenten-Chat geprüft. An Telegram wurde nichts gesendet.",
      CALLBACK_FAILED:
        "Ein Telegram-Button konnte nicht verarbeitet werden. Entscheide stattdessen in AgentPier.",
      TEAM_NOTIFICATION_FAILED:
        "Telegram-Benachrichtigungen für ein Team konnten nicht vorbereitet werden. Prüfe das Team in AgentPier.",
      DELIVERY_UNCERTAIN:
        "Telegram könnte die Antwort erhalten haben. Prüfe vor der Bestätigung deinen Chat; es wird nichts automatisch erneut gesendet.",
    },
  },
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
  loginCancel: "Anmeldung abbrechen",
  loginStatus: {
    starting: "Anmeldung wird gestartet …",
    awaiting_user: "Warte auf deine Anmeldung",
    completed: "ChatGPT verbunden",
    cancelled: "Anmeldung abgebrochen",
    failed: "Anmeldung fehlgeschlagen. Bitte versuche es erneut.",
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
  feature: {
    title: "Agenten aktivieren",
    description:
      "Agenten werden von OpenClaw verwaltet. Solange dies aus ist, zeigt AgentPier keine Agenten-Navigation und keine Konto-Bereiche und startet auf diesem Host keine Agentenverbindungen oder Hintergrundarbeit.",
    saving: "Wird gespeichert…",
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
  customModel: "Eigene Modell-ID …",
  chooseConnection: "Zugang auswählen",
  connections: "Zugänge verwalten",
  noConnections: "Verbinde unter Konten ChatGPT oder OpenRouter, um zu starten.",
  save: "Agent speichern",
  cancel: "Abbrechen",
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
  message: "Nachricht",
  send: "Senden",
  stop: "Antwort stoppen",
  you: "Du",
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
    cancelled: "Abgebrochen",
  },
};
