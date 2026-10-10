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

  invalid: "Ungültige Agenten-Eingabe.",
  notFound: "Agent oder Unterhaltung nicht gefunden.",
  conflict: "Die Daten wurden inzwischen geändert. Bitte neu laden.",
  unavailable: "Der Agentendienst ist nicht bereit. Prüfe die Laufzeit-Einstellungen.",
  provider: "Dieser Provider-Zugang ist für Agenten nicht verfügbar.",
  uncertain:
    "Der Ausgang dieser Anfrage ist noch unklar. Prüfe den Verlauf vor einem neuen Versuch.",
  active: "Es läuft noch eine Anfrage. Warte auf das Ergebnis oder stoppe sie zuerst.",
  disabled: "Agenten sind ausgeschaltet. Aktiviere sie unter Einstellungen > Agenten.",
  storageUnsafe:
    "Der Speicherordner der Agenten ist unsicher. Prüfe Eigentümer und Verknüpfungen im Datenverzeichnis.",
  restartRequired:
    "Agenten nutzen diesen Zugang. Eine Änderung startet ihr Gateway neu; bestätige den Neustart.",
};
