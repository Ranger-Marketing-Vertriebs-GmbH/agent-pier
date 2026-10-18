export const assistantTeamCopy = {
  modelChanged: "Modell: seit der Übernahme vom leitenden Agenten geändert",
  modelOriginal: "Modell: wie vom leitenden Agenten übernommen",
  followsLeadModel: "Folgt dem Modell des leitenden Agenten.",
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
  allowedChip: "Team erlaubt",
  archive: "Archivieren",
  restore: "Wiederherstellen",
  autonomous: "Teams ohne erneute Rückfrage erlauben",
  // Wie ein Lead seine Mitglieder von sich aus einbezieht (Server team-guidance.js).
  usage: "Team nutzen",
  usageLevels: {
    onRequest: "Auf Anfrage",
    suggest: "Vorschlagen",
    autonomous: "Selbstständig",
  },
  usageHints: {
    onRequest:
      "Der Agent fragt seine Mitglieder oder übergibt ihnen Aufgaben nur, wenn du ihn darum bittest.",
    suggest:
      "Der Agent schlägt in einem Satz vor, ein passendes Mitglied einzubeziehen, und wartet auf dein Ja. Dein Ja gilt als deine Anfrage.",
    autonomous:
      "Der Agent fragt Mitglieder und übergibt passende Aufgaben von sich aus, begrenzt pro Antwort und Stunde. Seine eigenen Aufgaben dürfen den Arbeitsbereich des Mitglieds ändern; Shell, SSH, Projektordner, GitHub und neue Teams behalten ihre üblichen Freigaben.",
  },
  memberShellSsh: "Team-Mitglieder dürfen Shell und SSH nutzen",
  memberShellSshHint:
    "Leitende Agenten geben ihren auftragsgebundenen Mitgliedern nur, was sie selbst haben. Mit dieser Option dürfen sie zusätzlich Shell geben, höchstens mit ihrer eigenen Stufe, und SSH auf ihren eigenen Hosts; jede spätere Freigabe bestätigst du. Sie gilt für Teams, die vorgeschlagen werden, während sie an ist. Mitglieder arbeiten unbeaufsichtigt, und Inhalte, die sie lesen, können sie lenken.",
  permissionHint:
    "Standardmäßig fragt der Agent nach. /team oder die Nachrichtenoption erlaubt ein Team für einen Auftrag.",
  maxMembers: "Maximale Teamgröße",
  timeout: "Laufzeit pro Mitglied (Minuten)",
  capacity: "Gleichzeitig aktive Mitglieder auf diesem Host",
  capacityRange: (min, max) => `Wähle einen Wert von ${min} bis ${max}.`,
  concurrentHint:
    "Alle Mitglieder dürfen gleichzeitig arbeiten, solange die gemeinsame Kapazität reicht.",
  save: "Team-Einstellungen speichern",
  permanent: "Dauerhafter Agent",
  taskBound: "Auftragsgebundenes Mitglied",
  independent:
    "Modell und Anweisungen gehören diesem Agenten. Änderungen am leitenden Agenten überschreiben sie nicht.",
  independentTask:
    "Die Anweisungen sind eine unabhängige Kopie, die Änderungen am leitenden Agenten nicht überschreiben; nach Abschluss kannst du sie ändern. Das Modell folgt immer dem leitenden Agenten.",
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
    "member-result": "Antwort eines Mitglieds eingegangen. Der Agent gibt sie weiter.",
    "coding-result": "Ergebnis eines Coding-Laufs eingegangen.",
    "memory-result":
      "Eine Notiz im Projektwissen wurde nicht gespeichert. Der Agent wurde informiert.",
    "ssh-result": "Ergebnis eines SSH-Befehls eingegangen.",
  },
  notes: {
    started: (title) => `Team gestartet: ${title}`,
    completed: (title) => `Team abgeschlossen: ${title}`,
    partial: (title) => `Team teilweise abgeschlossen: ${title}`,
    failed: (title) => `Team fehlgeschlagen: ${title}`,
    cancelled: (title) => `Team abgebrochen: ${title}`,
    unsent: (title) =>
      `Team-Ergebnisse konnten nicht an den Agenten übergeben werden: ${title}`,
    declined: (title) => `Teamvorschlag abgelehnt: ${title}`,
  },
  awaitingReview: "Wartet auf deine Prüfung",
  reviewTitle: (title) => `Prüfung nötig: ${title}`,
  reviewHint:
    "Das Ergebnis dieser Mitglieder ist unklar. Das Team kann erst abschließen, wenn du sie prüfst.",
  reviewMember: (name) => `${name} prüfen`,
  pendingTitle: "Teams warten auf dich",
  listHint:
    "Alle Teams, die dieser Agent gestartet hat, mit Mitgliedern, Status und Ergebnissen. Öffne ein Mitglied, um seinen Chat zu lesen.",
  filterLabel: "Teams anzeigen",
  active: (count) => `Aktiv (${count})`,
  archived: (count) => `Archiviert (${count})`,
  noTeams: "Dieser Agent hat noch kein Team gestartet.",
  noActive: "Keine aktiven Teams.",
  noArchived: "Keine archivierten Teams.",
  showInChat: "Im Chat zeigen",
  report: "Bericht",
  noReport: "Kein schriftlicher Bericht",
  // A report stored incomplete beyond the history limit.
  reportShortened: "Gekürzt – der vollständige Bericht steht im Chat des Mitglieds.",
  openMemberChat: "Chat öffnen",
  results: {
    queued: "Ergebnisse warten auf die Zusammenfassung",
    pending: "Ergebnisse werden im Chat zusammengefasst",
    accepted: "Ergebnisse werden im Chat zusammengefasst",
    running: "Ergebnisse werden im Chat zusammengefasst",
    completed: "Ergebnisse im Chat zusammengefasst",
    failed: "Die Zusammenfassung ist fehlgeschlagen",
    cancelled: "Die Zusammenfassung wurde gestoppt",
    interrupted: "Ergebnis der Zusammenfassung unklar",
    uncertain: "Ergebnis der Zusammenfassung unklar",
    reviewed: "Ergebnis der Zusammenfassung geprüft",
    skipped: "Keine Zusammenfassung",
    unsent:
      "Die Ergebnisse konnten nicht an den Agenten übergeben werden. Lies die Berichte hier.",
  },
  inherited: (name, revision) =>
    `Erstellt von ${name} · übernommene Revision ${revision}`,
};
