export const assistants = {
  actionHumanReview:
    "Die Coding-Pipeline wartet auf deine Entscheidung. Öffne den Lauf in AgentPier.",
  actionApproval: "Aktion zur Freigabe",
  actionRequestedByMember: (name) => `Angefragt von Teammitglied ${name}`,
  actionApprove: "Aktion freigeben",
  actionDecline: "Aktion ablehnen",
  actionStates: {
    approved: "Aktion freigegeben",
    running: "Coding-Auftrag läuft",
    completed: "Auftrag abgeschlossen",
    failed: "Aktion fehlgeschlagen; bitte in AgentPier prüfen",
    cancelled: "Auftrag abgebrochen",
    declined: "Aktion abgelehnt",
    expired: "Die Freigabe ist abgelaufen",
    unknown: "Ergebnis unklar; bitte in AgentPier prüfen",
    reviewed: "Ergebnis geprüft; Aktion wird nicht wiederholt",
  },

  execApproval: "Shell-Befehl zur Freigabe",
  execAgent: (name) => `Agent: ${name}`,
  execCwd: "Ordner:",
  execAllowOnce: "Einmal erlauben",
  execAllowAlways: "Immer erlauben",
  execDeny: "Ablehnen",
  execAllowAlwaysPrograms: (programs) =>
    `„Immer erlauben“ erlaubt diesem Agenten künftig ohne Nachfrage, jeweils mit beliebigen Argumenten: ${programs}. Manche Programme können über ihre Argumente andere Befehle ausführen, etwa git über Hooks oder Aliase; „Immer erlauben“ deckt auch das ab. Du kannst die Einträge in den Agent-Einstellungen löschen.`,
  execWritablePrograms: (programs) =>
    `In Ordnern, in die du schreiben kannst, liegen: ${programs}. Wird eines davon geändert oder ersetzt, führt der Agent die neue Version ohne Nachfrage aus. Befehle mit Umleitungen (> oder <) lehnt OpenClaw für solche Programme immer ab.`,
  execAllowAlwaysOnce: (reason) =>
    `„Immer erlauben“ erlaubt diesen Befehl nur einmal: ${reason}. Beim nächsten Mal fragt der Agent erneut.`,
  execOnceReasons: {
    interpreter: (program) =>
      `${program} ist ein Interpreter, eine Shell oder ein Starter`,
    inline: (program) => `${program} führt ein eingebettetes Skript aus`,
    unresolved: (program) =>
      `AgentPier kann ${program} keinem festen Programmpfad zuordnen`,
  },
  execOnceCommandReasons: {
    inline: "der Befehl führt ein eingebettetes Skript aus",
    unresolved: "AgentPier kann den Befehl keinem festen Programm zuordnen",
    complex:
      "der Befehl nutzt Shell-Syntax, die AgentPier keinen festen Programmen zuordnen kann, etwa Variablen, Umgebungszuweisungen, Befehlsersetzung, Subshells, Kontrollstrukturen oder Hintergrundjobs",
  },
  execDecided: {
    "allow-once": "Befehl einmal erlaubt",
    "allow-always": "Befehl immer erlaubt",
    deny: "Befehl abgelehnt",
  },
  execStates: {
    declined: "Befehl abgelehnt",
    expired: "Freigabe abgelaufen; der Befehl wurde nicht ausgeführt",
    cancelled: "Freigabe abgebrochen; der Befehl wurde nicht ausgeführt",
    failed: "Freigabe fehlgeschlagen; bitte in AgentPier prüfen",
    unknown: "Ergebnis unklar; bitte in AgentPier prüfen",
  },
  sshApproval: "SSH-Befehl wartet auf Freigabe",
  sshAgent: (name) => `Agent: ${name}`,
  sshRequestedBy: (name) => `Angefragt von ${name}`,
  sshTarget: (name, endpoint) => `Host: ${name} (${endpoint})`,
  sshTimeout: (seconds) => `Zeitlimit: ${seconds} s`,
  sshOpenToApprove:
    "Der Befehl ist lang oder enthält versteckte Zeichen. Prüfe und erlaube ihn in AgentPier.",
  sshAllowOnce: "Einmal erlauben",
  sshDeny: "Ablehnen",
  sshStates: {
    completed: (code) => `SSH-Befehl beendet · Exit-Code ${code}`,
    failed: "SSH-Befehl fehlgeschlagen; prüfe ihn in AgentPier",
    declined: "SSH-Befehl abgelehnt",
    expired: "Freigabe abgelaufen; der Befehl lief nicht",
    cancelled: "Freigabe abgebrochen; der Zugang hat sich geändert",
    unknown: "Ergebnis unbekannt; prüfe es in AgentPier",
  },
  sshTimedOut: "Zeitlimit erreicht",
  sshTruncated: "Ausgabe gekürzt",
  execAllowlistPrograms: (programs) =>
    `Für diesen Agenten jetzt immer erlaubt, jeweils mit beliebigen Argumenten: ${programs}. Manche Programme können über ihre Argumente andere Befehle ausführen, etwa git über Hooks oder Aliase; „Immer erlauben“ deckt auch das ab. Du kannst die Einträge in den Agent-Einstellungen löschen.`,
  execAllowlistSkipped: (reason) =>
    `Der Befehl wurde einmal erlaubt: ${reason}. Beim nächsten Mal fragt der Agent erneut.`,
  execAllowlistFailed:
    "Der Befehl wurde einmal erlaubt, aber AgentPier konnte ihn nicht in die Liste erlaubter Befehle eintragen. Beim nächsten Mal fragt der Agent erneut.",

  heartbeatMemoryRequired:
    "Meldungen brauchen das Gedächtnis. Schalte zuerst „Informationen merken“ ein oder schalte die Meldungen mit ab.",
  heartbeatPrefix: "Check-in:",
  reminderChannelRequired:
    "Um auch an Telegram zu senden, verbinde zuerst einen Telegram-Chat mit diesem Agenten.",
  reminderTimezoneRequired:
    "Gib den Erinnerungszeitpunkt mit Zeitzonen-Offset an, zum Beispiel 2026-10-09T09:00:00+02:00.",
  routineReviewRequired:
    "Ob diese Routine angelegt wurde, ist unklar. Prüfe sie in den Agent-Einstellungen, bevor du es erneut versuchst.",
  reminderReviewRequired:
    "Ob diese Erinnerung angelegt wurde, ist unklar. Prüfe sie in den Agent-Einstellungen, bevor du es erneut versuchst.",
  reminderFailed:
    "Eine Erinnerung konnte nicht ausgeführt werden. Prüfe ihren Verlauf in den Agent-Einstellungen.",
  teamResultNoText: (objective) =>
    `Team-Ergebnisse für ${objective}. Für die abgeschlossene Zusammenfassung ist kein Text verfügbar. Prüfe die Einzelberichte.`,
  teamReportUnavailable:
    "Kein Textbericht verfügbar. Öffne den Mitglieder-Chat für weitere Details.",
  teamReportShortened: "Bericht gekürzt – vollständig im Chat des Mitglieds.",
  teamResultStates: {
    completed: "Abgeschlossen",
    failed: "Fehlgeschlagen",
    cancelled: "Abgebrochen",
  },
  teamApproval: (objective, count) =>
    `Team-Freigabe: ${objective}\n${count} Mitglieder. Freigeben oder ablehnen?`,
  memberGrants: {
    labels: {
      memory: "Gedächtnis des leitenden Agenten (nur lesend)",
      reminders: "Erinnerungen",
      webSearch: "Websuche",
      webFetch: "Webseiten",
      browser: "Browser",
      documents: "Bilder",
      readPdfs: "PDFs",
      createImages: "Bilder erstellen",
      allSkills: "alle Skills des leitenden Agenten",
      skills: (count) => `Skills: ${count}`,
      shell: (level) => `⚠ Shell (${level})`,
      ssh: "⚠ SSH auf den Hosts des leitenden Agenten",
      mcpServers: (count) => `MCP-Server: ${count}`,
      projects: (count) => `Projektordner: ${count}`,
      github: (level) => `GitHub (${level})`,
    },
    githubLevels: { read: "lesen", write: "lesen und schreiben" },
    levels: { approval: "mit Freigabe", full: "voller Zugriff" },
    gets: (labels) => `Erhält: ${labels}`,
    getsNothing: "Erhält: keine Tools",
    promoted: (lead, member) =>
      `${lead} hat sein Team-Mitglied ${member} als dauerhaften Agenten behalten. Es behält seine Web-Tools, das Lesen von Bildern, Skills, MCP-Server und Erinnerungen, und nur sein eigenes Gedächtnis, nicht das seines leitenden Agenten; Shell, SSH, Projektordner und GitHub erhält es nicht. Du kannst es in seinen Einstellungen prüfen oder archivieren.`,
    proposalWarning:
      "⚠ Mit ⚠ markierte Mitglieder erhalten Shell oder SSH, höchstens mit der Stufe und auf den Hosts des leitenden Agenten. Sie arbeiten unbeaufsichtigt; gelesene Inhalte können sie lenken.",
    approval: (lead, member) =>
      `Team-Freigabe wartet: ${lead} möchte seinem Mitglied ${member} mehr Zugriff geben.`,
    warning:
      "Das Mitglied arbeitet unbeaufsichtigt, und Inhalte, die es liest, können es zur Nutzung dieses Zugriffs verleiten.",
    approve: "Freigabe erteilen",
    states: {
      completed: "Freigabe erteilt und angewendet",
      declined: "Freigabe abgelehnt",
      expired: "Die Rechte-Freigabe ist abgelaufen",
      failed: "Freigabe nicht mehr möglich; nichts geändert",
      cancelled: "Freigabe zurückgezogen",
    },
  },
  teamMcpServers: (names) => `MCP-Server: ${names}`,
  teamMcpStdio: (name) => `${name} (stdio, lokaler Befehl)`,
  teamMcpUnavailable:
    "MCP-Server: Die Liste lässt sich gerade nicht lesen. Genehmige das Team in AgentPier, sobald sie lesbar ist.",
  teamApprove: "Team freigeben",
  teamDecline: "Team ablehnen",
  teamApproved:
    "Team freigegeben. Die Aufgaben werden eingeplant; ich melde mich, sobald das Team arbeitet.",
  teamDeclined: "Team abgelehnt. Es werden keine Agenten für diesen Vorschlag gestartet.",
  teamDecisionStale:
    "Dieser Vorschlag wurde bereits entschieden oder ist nicht mehr gültig.",
  teamDecisionFailed:
    "Die Entscheidung konnte nicht gespeichert werden. Versuche es in AgentPier erneut.",
  telegramReplyUnavailable:
    "Die Antwort enthält keinen Text. Öffne AgentPier, um sie anzusehen.",
  telegramReplyIncomplete: "Antwort gekürzt – der Rest konnte nicht gesendet werden.",
  telegramInputNeedsReview: "Eine Nachricht braucht deine Aufmerksamkeit in AgentPier.",
  telegramPrivateBot:
    "Dieser Bot ist privat und antwortet nur der Person, mit der er verbunden ist.",
  telegramMediaUnsupported:
    "Dieser Nachrichtentyp wird noch nicht unterstützt. Sende Text oder eine Sprachnachricht.",
  telegramMediaCaptionUnsupported:
    "Dieser Nachrichtentyp wird noch nicht unterstützt, und die Bildunterschrift wurde nicht verarbeitet. Sende Text oder eine Sprachnachricht.",
  telegramVoiceTooLong: (minutes) =>
    `Sprachnachrichten dürfen höchstens ${minutes} min lang sein. Sende eine kürzere Nachricht oder schreibe sie als Text.`,
  telegramOpenInAgentPier: "In AgentPier öffnen",
  telegramQueueFull:
    "Die Warteschlange ist voll. Diese Nachricht wurde nicht angenommen; versuche es später erneut.",
  teamStartedBecause: (quote) => `Gestartet, weil du geschrieben hast: „${quote}“`,
  teamStarted: (objective, count, total) =>
    `Das Team arbeitet an: ${objective}\n${count} von ${total} Agenten arbeiten gerade. Ich melde mich mit den Ergebnissen.`,
  teamResultFailed: (objective) =>
    `Team-Ergebnisse für ${objective}. Die Zusammenfassung ist fehlgeschlagen oder wurde abgebrochen. Prüfe die Einzelberichte.`,

  channelUnavailable: "Der Kanaldienst ist gerade nicht erreichbar. Versuche es erneut.",
  channelWebhook:
    "Der Telegram-Bot verwendet bereits einen Webhook. Trenne zuerst die andere Integration.",
  channelPolling:
    "Ein anderer Dienst verwendet diesen Telegram-Bot. Stoppe ihn vor dem Fortsetzen.",
  channelToken: "Der Telegram-Bot-Token ist ungültig.",
  telegramBotInUse:
    "Dieser Telegram-Bot wird bereits genutzt: als dein AgentPier-Bot oder von einem anderen Agenten. Lege für jeden Zweck einen eigenen Bot an.",
  skillUnavailable:
    "Dieser Skill ist nicht als mitgelieferter OpenClaw-Skill verfügbar, oder ein gleichnamiger Skill in den Ordnern des Agenten würde an seiner Stelle laufen.",
  telegramSendersShell:
    "Ein Agent mit eigenem Telegram-Bot für andere Personen darf keinen Shell-Zugriff haben. Schalte die Shell aus oder trenne zuerst den Bot.",
  telegramSendersStdio:
    "Diesem Agenten ist ein stdio-MCP-Server zugeordnet, der Befehle auf diesem Rechner ausführt. Entferne ihn, bevor du einen Bot für andere Personen verbindest.",
  telegramSendersSsh:
    "Ein Agent mit eigenem Telegram-Bot für andere Personen darf keine SSH-Zugänge haben. Entferne die SSH-Zugänge oder trenne zuerst den Bot.",
  telegramSendersGithub:
    "Ein Agent mit eigenem Telegram-Bot für andere Personen darf keinen GitHub-Zugriff haben. Entferne den GitHub-Zugriff oder trenne zuerst den Bot.",
  githubFromLead:
    "Ein auftragsgebundenes Team-Mitglied erhält GitHub nur von seinem leitenden Agenten.",
  githubProfileUnavailable:
    "Dieses GitHub-Tokenprofil gibt es nicht mehr. Wähle unter Einstellungen › Zugriff › GitHub-Zugänge ein anderes.",
  sshNotGranted: "Dieser SSH-Zugang ist dem Agenten nicht zugewiesen.",
  sshHostUnavailable:
    "Dieser SSH-Zugang ist nicht verfügbar: Er wurde entfernt, oder OpenSSH fehlt.",
  sshRoutineNotTrusted:
    "In Routinen laufen nur SSH-Zugänge mit „Vertraut inkl. Routinen“.",
  sshOriginRefused: "SSH ist in dieser Runde nicht erlaubt.",
  sshBusy: "Für diesen Agenten läuft bereits ein SSH-Befehl.",
  sshApprovalLimit:
    "Für diesen Agenten warten bereits drei SSH-Befehle auf deine Freigabe.",
  sshRevoked: "Der SSH-Zugang hat sich geändert; der Befehl wurde gestoppt.",
  projectFolderNotGranted: "Dieser Projektordner ist dem Agenten nicht freigegeben.",
  projectFolderReadOnly: "Der Agent darf diesen Projektordner nur lesen.",
  projectRoutineReadOnly:
    "Diese Routine darf Projektordner nur lesen: Schalte in ihren Details „Darf schreiben“ ein, damit sie Dateien ändern darf.",
  projectWriteUnavailable:
    "Änderungen in Projektordnern sind erst möglich, wenn der Tool-Schutz der Agenten-Laufzeit bestätigt ist.",
  projectPathRefused:
    "Dieser Pfad ist nicht erlaubt: Er muss im Projektordner bleiben; .git, Links nach außen und AgentPiers eigene Daten sind gesperrt.",
  projectFileUnsuitable:
    "Diese Datei ist zu groß, binär oder keine normale Datei für diese Aktion.",
  projectEditNoMatch: "Der zu ersetzende Text kommt in der Datei nicht genau einmal vor.",
  projectFileEncoding:
    "Diese Datei ist kein gültiges UTF-8; sie wird nicht geändert, damit keine Zeichen verloren gehen.",
  projectWriteTooLarge: "Ein Schreibvorgang darf höchstens 64 KiB umfassen.",
  memberModelFollowsLead:
    "Ein auftragsgebundenes Mitglied nutzt das Modell seines leitenden Agenten. Ändere das Modell dort oder behalte das Mitglied als dauerhaften Agenten.",
  memberRequestNotPermanent:
    "Aufgaben lassen sich nur an dauerhafte Mitglieder übergeben.",
  memberRequestOpenTask:
    "Dieses Mitglied hat schon eine offene Aufgabe. Warte auf ihr Ergebnis oder brich sie ab.",
  memberRequestNotFinished:
    "Nur abgeschlossene temporäre Mitglieder lassen sich archivieren.",
  memberRequestRate:
    "Der Agent hat in kurzer Zeit zu viele Fragen oder Aufgaben geschickt. Warte einen Moment.",
  memberRequestAutonomousLimit:
    "Der Agent hat vorerst die meisten Fragen und Aufgaben aus eigenem Antrieb gestellt. Bitte ihn ausdrücklich darum, wenn er mehr tun soll.",
  memberTemplate: (name) => `Vorlage: ${name} (Agency-Agenten)`,
  memberTemplateWarned: (findings) =>
    `Die Prüfung hat gefunden: ${findings}. Prüfe die Vorlage vor der Freigabe.`,
  // Die Regeln der Skill-Prüfung (skill-scan.js), wie der Browser sie nennt.
  scanRules: {
    "download-exec": "Lädt Code herunter und führt ihn aus",
    "credential-exfiltration": "Liest Zugangsdaten und sendet Daten",
    "bidi-control": "Unsichtbare Steuerzeichen für die Textrichtung",
    "unicode-tag": "Unsichtbare Unicode-Tag-Zeichen",
    "invisible-character": "Unsichtbare Zeichen",
    "prompt-injection": "Formulierung, die Anweisungen ersetzen will",
    "encoded-blob": "Langer kodierter Datenblock",
    "executable-file": "Ausführbare Datei",
    "binary-executable": "Ausführbares Programm (Binärdatei)",
  },
  templateNotFound: "Dieser Agency-Agent ist nicht im Katalog.",
  templateBlocked: "Die Prüfung hat diesen Agency-Agenten blockiert.",
  templateTooLarge: "Dieser Agency-Agent ist zu lang für eine Vorlage.",
  templateUnavailable: "Agency-Vorlagen sind gerade nicht verfügbar.",
  memberRequestUnavailable:
    "Dieses Mitglied hat noch keinen Chat und kann nichts beantworten.",
  memberRequestNoReply: (member) =>
    `${member} hat geantwortet, aber die Zusammenfassung des Agenten enthält keinen Text. Sieh im Chat nach.`,
  telegramSendersArchive:
    "Trenne zuerst den eigenen Telegram-Bot des Agenten, bevor du ihn archivierst.",
  telegramSendersRestartRequired:
    "Diese Telegram-Änderung startet das Gateway der Agenten neu; bestätige den Neustart.",

  teamMcpServersUnavailable:
    "Die MCP-Serverliste dieses Teams lässt sich gerade nicht lesen. Versuche es später erneut.",
  teamShareAccessOnly:
    "Mit einem dauerhaften Mitglied kann ein leitender Agent nur Projektordner, Coding-Projekte und MCP-Server teilen.",
  teamGrantNotHeld:
    "Ein leitender Agent kann einem Teammitglied nur geben, was er selbst hat; Shell und SSH nur mit der Einstellung „Team-Mitglieder dürfen Shell und SSH nutzen“.",
  leadRoutineOwnerTurn:
    "Ein leitender Agent legt Routinen bei seinen Mitgliedern nur in einer Antwort auf deine eigene Nachricht an oder ändert sie.",
  leadRoutineNotPermanent:
    "Routinen lassen sich nur bei dauerhaften Mitgliedern anlegen; temporäre Mitglieder arbeiten nur an ihrem Auftrag.",
  leadRoutineMemberOff: "Bei diesem Mitglied sind Routinen ausgeschaltet.",
  leadRoutineInterval:
    "Eine Routine bei einem Mitglied darf höchstens alle 15 Minuten laufen.",
  leadRoutineNotRequested:
    "Bei der Team-Nutzung „Auf Anfrage“ legt ein leitender Agent eine Routine bei einem Mitglied nur an, wenn deine Nachricht dieses Mitglied nennt.",
  leadRoutineLimit:
    "Der leitende Agent hat bei diesem Mitglied bereits die höchstmögliche Zahl an Routinen angelegt.",
  memberReminderLimit:
    "Die Mitglieder dieses Teams haben bereits die höchstmögliche Zahl an Erinnerungen beim leitenden Agenten angelegt.",
  teamGrantMemberEnded:
    "Rechte lassen sich nur einem laufenden auftragsgebundenen Mitglied des eigenen Teams geben.",
  teamMcpServerNotBound:
    "Ein vorgeschlagenes Teammitglied nennt einen MCP-Server, der dem leitenden Agenten nicht zugewiesen ist.",
  attachmentTooLarge: "Diese Datei ist größer als 10 MB.",
  attachmentUnsupported:
    "Dieser Dateityp wird nicht unterstützt. Erlaubt sind Bilder (JPEG, PNG, WebP, GIF, HEIC), Videos (MP4, MOV, WebM), PDF und Textdateien.",
  videoTooLarge: "Videos dürfen höchstens 200 MB groß sein.",
  videoUploadsBusy:
    "Dieser Agent empfängt bereits drei Videos. Warte, bis eines fertig ist.",
  videoUploadOffset:
    "Der Upload wurde unterbrochen. Er wird an der unterbrochenen Stelle fortgesetzt.",
  attachmentTooMany:
    "Zu viele Anhänge. Eine Nachricht kann höchstens 5 Dateien enthalten.",
  attachmentNotFound:
    "Dieser Anhang ist nicht mehr verfügbar. Füge die Datei erneut hinzu.",
  attachmentStorageFull:
    "Der Anhang-Ordner dieses Agenten ist voll. Bitte den Agenten, ältere Dateien in attachments/ zu löschen, oder leere sie im Profil des Agenten unter Chat-Anhänge.",
  attachmentStorageUnsafe:
    "Der Anhang-Ordner im Arbeitsbereich dieses Agenten ist unsicher. Prüfe, ob attachments/ ein normaler Ordner ist, oder leere ihn im Profil des Agenten unter Chat-Anhänge.",
  attachmentRateLimited: "Zu viele Anhänge in kurzer Zeit. Warte einen Moment.",
  shareNotFound: "Unter diesem Pfad liegt im Arbeitsbereich des Agenten keine Datei.",
  shareOutside:
    "Agenten können nur normale Dateien aus ihrem eigenen Arbeitsbereich teilen, ohne symbolische oder harte Links.",
  shareTooLarge: "Geteilte Dateien sind auf 25 MB begrenzt.",
  shareEmpty: "Diese Datei ist leer.",
  invalid: "Ungültige Agenten-Eingabe.",
  notFound: "Agent oder Unterhaltung nicht gefunden.",
  conflict: "Die Daten wurden inzwischen geändert. Bitte neu laden.",
  capacity:
    "Die Teamgröße liegt über der Kapazität dieses Hosts. Wähle einen kleineren Wert.",
  hostCapacity:
    "Mindestens ein Agententeam ist größer als dieser Wert. Wähle eine größere Kapazität oder verkleinere das Team.",
  unavailable: "Der Agentendienst ist nicht bereit. Prüfe die Laufzeit-Einstellungen.",
  agentLoading:
    "Der Agentendienst hat den Agenten nicht rechtzeitig geladen. Versuche es in einem Moment erneut.",
  provider: "Dieser Provider-Zugang ist für Agenten nicht verfügbar.",
  uncertain:
    "Der Ausgang dieser Anfrage ist noch unklar. Prüfe den Verlauf vor einem neuen Versuch.",
  queuedTooLong:
    "Die wartende Nachricht hat keinen Platz für mehr Text. Bearbeite sie zuerst.",
  queuedSending: "Die wartende Nachricht wird gerade gesendet.",
  queuedAttachment: "Dieser Anhang gehört zu einer wartenden Nachricht.",
  queuedFailed: "Die wartende Nachricht wurde nicht gesendet. Bearbeite sie zuerst.",
  queuedExpired:
    "Die wartende Nachricht war älter als einen Tag und wurde nicht mehr gesendet.",
  queuedArchived: "Dieser Agent ist archiviert und nimmt keine Nachrichten mehr an.",
  active: "Es läuft noch eine Anfrage. Warte auf das Ergebnis oder stoppe sie zuerst.",
  disabled: "Agenten sind ausgeschaltet. Aktiviere sie unter Einstellungen › Agenten.",
  storageUnsafe:
    "Der Speicherordner der Agenten ist unsicher. Prüfe Eigentümer und Verknüpfungen im Datenverzeichnis.",
  restartRequired:
    "Agenten nutzen diesen Zugang. Eine Änderung startet ihr Gateway neu; bestätige den Neustart.",
  webToolsRestartRequired:
    "Diese Änderung an den Web-Tools startet das Gateway der Agenten neu; bestätige den Neustart.",
  advancedRestartRequired:
    "Diese Einstellung wird erst nach einem Neustart des Agentendienstes wirksam; bestätige den Neustart.",
  advancedSettingUnavailable:
    "Diese Einstellung ist mit der installierten Agenten-Laufzeit nicht verfügbar.",
  shellConfirmationRequired:
    "Mit Shell-Zugriff führt der Agent Befehle als dein Benutzerkonto auf diesem Rechner aus, auch außerhalb seines Arbeitsbereichs. Bestätige die Warnung, um den Zugriff einzuschalten.",
  shellFullConfirmationRequired:
    "Mit vollem Shell-Zugriff führt der Agent jeden Befehl ohne Nachfrage aus. Bestätige das ausdrücklich.",
  modelsRateLimited:
    "Zu viele Aktualisierungen der Modellliste. Bitte versuche es in einer Minute erneut.",
  allowlistEntryNotFound:
    "Dieser Eintrag steht nicht mehr in der Liste erlaubter Befehle. Bitte neu laden.",
  browserUnavailable:
    "Für diesen Agenten gibt es gerade kein Browserprofil. Starte den Agentendienst neu oder versuche es später.",
  browserVisibleLimit:
    "Es laufen bereits drei sichtbare Agenten-Browser. Warte, bis einer frei ist, und versuche es erneut.",
  userAgentLocked: "Für Agenten von Benutzern gesperrt.",
};
