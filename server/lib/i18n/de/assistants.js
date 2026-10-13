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
    expired: "Freigabe abgelaufen",
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
  execAllowlistPrograms: (programs) =>
    `Für diesen Agenten jetzt immer erlaubt, jeweils mit beliebigen Argumenten: ${programs}. Manche Programme können über ihre Argumente andere Befehle ausführen, etwa git über Hooks oder Aliase; „Immer erlauben“ deckt auch das ab. Du kannst die Einträge in den Agent-Einstellungen löschen.`,
  execAllowlistSkipped: (reason) =>
    `Der Befehl wurde einmal erlaubt: ${reason}. Beim nächsten Mal fragt der Agent erneut.`,
  execAllowlistFailed:
    "Der Befehl wurde einmal erlaubt, aber AgentPier konnte ihn nicht in die Liste erlaubter Befehle eintragen. Beim nächsten Mal fragt der Agent erneut.",

  heartbeatMemoryRequired:
    "Meldungen brauchen das Gedächtnis. Schalte zuerst „Informationen merken“ ein oder schalte die Meldungen mit ab.",
  heartbeatPrefix: "Check-in:",
  heartbeatChannelRequired:
    "Check-ins brauchen einen verbundenen Telegram-Chat. Verbinde zuerst einen Telegram-Chat mit diesem Agenten.",
  reminderChannelRequired: "Verbinde zuerst einen Telegram-Chat mit diesem Agenten.",
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
  teamResultStates: {
    completed: "Abgeschlossen",
    failed: "Fehlgeschlagen",
    cancelled: "Abgebrochen",
  },
  teamApproval: (objective, count) =>
    `Team-Freigabe: ${objective}\n${count} Mitglieder. Freigeben oder ablehnen?`,
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
  telegramSendersShell:
    "Ein Agent mit eigenem Telegram-Bot für andere Personen darf keinen Shell-Zugriff haben. Schalte die Shell aus oder trenne zuerst den Bot.",
  telegramSendersStdio:
    "Diesem Agenten ist ein stdio-MCP-Server zugeordnet, der Befehle auf diesem Rechner ausführt. Entferne ihn, bevor du einen Bot für andere Personen verbindest.",
  memberRequestNotPermanent:
    "Aufgaben lassen sich nur an dauerhafte Mitglieder übergeben.",
  memberRequestOpenTask:
    "Dieses Mitglied hat schon eine offene Aufgabe. Warte auf ihr Ergebnis oder brich sie ab.",
  memberRequestNotFinished:
    "Nur abgeschlossene temporäre Mitglieder lassen sich archivieren.",
  memberRequestUnavailable:
    "Dieses Mitglied hat noch keinen Chat und kann nichts beantworten.",
  memberRequestApproval: (lead, member, kind, text) =>
    `${lead} möchte ${kind === "task" ? "eine Aufgabe an" : "eine Frage an"} ${member} ${kind === "task" ? "übergeben" : "stellen"}:\n\n${text}`,
  memberRequestApprove: "Anfrage freigeben",
  memberRequestDecline: "Anfrage ablehnen",
  memberRequestApproved:
    "Freigegeben. Das Mitglied bekommt die Anfrage, sobald es frei ist.",
  memberRequestDeclined: "Abgelehnt. Das Mitglied bekommt die Anfrage nicht.",
  memberRequestNoReply: (member) =>
    `${member} hat geantwortet, aber die Zusammenfassung des Agenten enthält keinen Text. Sieh im Chat nach.`,
  telegramSendersArchive:
    "Trenne zuerst den eigenen Telegram-Bot des Agenten, bevor du ihn archivierst.",
  telegramSendersRestartRequired:
    "Diese Telegram-Änderung startet das Gateway der Agenten neu; bestätige den Neustart.",

  teamMcpServersUnavailable:
    "Die MCP-Serverliste dieses Teams lässt sich gerade nicht lesen. Versuche es später erneut.",
  teamMcpServerNotBound:
    "Ein vorgeschlagenes Teammitglied nennt einen MCP-Server, der dem leitenden Agenten nicht zugewiesen ist.",
  attachmentTooLarge: "Diese Datei ist größer als 10 MB.",
  attachmentUnsupported:
    "Dieser Dateityp wird nicht unterstützt. Erlaubt sind Bilder (JPEG, PNG, WebP, GIF, HEIC), PDF und Textdateien.",
  attachmentTooMany:
    "Zu viele Anhänge. Eine Nachricht kann höchstens 5 Dateien enthalten.",
  attachmentNotFound:
    "Dieser Anhang ist nicht mehr verfügbar. Füge die Datei erneut hinzu.",
  attachmentStorageFull:
    "Der Anhang-Ordner dieses Agenten ist voll. Bitte den Agenten, ältere Dateien in attachments/ zu löschen.",
  attachmentStorageUnsafe:
    "Der Anhang-Ordner im Arbeitsbereich dieses Agenten ist unsicher. Prüfe, ob attachments/ ein normaler Ordner ist.",
  attachmentRateLimited: "Zu viele Anhänge in kurzer Zeit. Warte einen Moment.",
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
  active: "Es läuft noch eine Anfrage. Warte auf das Ergebnis oder stoppe sie zuerst.",
  disabled: "Agenten sind ausgeschaltet. Aktiviere sie unter Einstellungen > Agenten.",
  storageUnsafe:
    "Der Speicherordner der Agenten ist unsicher. Prüfe Eigentümer und Verknüpfungen im Datenverzeichnis.",
  restartRequired:
    "Agenten nutzen diesen Zugang. Eine Änderung startet ihr Gateway neu; bestätige den Neustart.",
  webToolsRestartRequired:
    "Diese Änderung an den Webwerkzeugen startet das Gateway der Agenten neu; bestätige den Neustart.",
  shellConfirmationRequired:
    "Mit Shell-Zugriff führt der Agent Befehle als dein Benutzerkonto auf diesem Rechner aus, auch außerhalb seines Arbeitsbereichs. Bestätige die Warnung, um den Zugriff einzuschalten.",
  shellFullConfirmationRequired:
    "Mit vollem Shell-Zugriff führt der Agent jeden Befehl ohne Nachfrage aus. Bestätige das ausdrücklich.",
  modelsRateLimited:
    "Zu viele Aktualisierungen der Modellliste. Bitte versuche es in einer Minute erneut.",
  allowlistEntryNotFound:
    "Dieser Eintrag steht nicht mehr in der Liste erlaubter Befehle. Bitte neu laden.",
};
