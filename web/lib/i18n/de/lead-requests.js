// Fragen und Aufgaben eines leitenden Agenten an seine eigenen Teammitglieder.
export const leadRequestCopy = {
  // Die Meta-Zeile unter einer Nachricht, die der leitende Agent geschickt hat.
  from: (name) => `von ${name}`,
  at: (from, time) => `${from} · ${time}`,
  spokenAt: (from, time) => `${from}, ${time}`,
  permanentSection: "Dauerhaft",
  temporarySection: "Temporär",
  types: { question: "Frage", task: "Aufgabe" },
  title: (type, member) =>
    type === "task" ? `Aufgabe für ${member}` : `Frage an ${member}`,
  states: {
    awaiting_approval: "Wartet auf Freigabe",
    queued: "Wartet auf das Mitglied",
    dispatching: "Wird gesendet",
    running: "In Arbeit",
    uncertain: "Ausgang unklar",
    completed: "Erledigt",
    answered: "Beantwortet",
    failed: "Fehlgeschlagen",
    cancelled: "Abgebrochen",
    declined: "Abgelehnt",
  },
  approvalHint:
    "Dein Agent möchte das an sein Mitglied schicken. Es geht raus, sobald du freigibst und das Mitglied frei ist.",
  shell: (level) =>
    `Shell-Zugriff des Mitglieds: ${{ off: "aus", approval: "mit Freigabe", full: "voll" }[level] || level}`,
  mcp: (names) => `MCP-Server des Mitglieds: ${names}`,
  noMcp: "MCP-Server des Mitglieds: keine",
  mcpUnavailable: "Die MCP-Server des Mitglieds lassen sich gerade nicht auflisten.",
  stdio: (name) => `${name} (stdio, lokaler Befehl)`,
  writesIfApproved: (member) =>
    `Wenn du freigibst, darf ${member} Dateien in seinem eigenen Arbeitsbereich ändern (nicht sein Gedächtnis).`,
  writes: (member) =>
    `${member} darf Dateien in seinem eigenen Arbeitsbereich ändern (nicht sein Gedächtnis).`,
  readOnly: (member) => `${member} ändert für diese Aufgabe keine Dateien.`,
  showAll: "Alles anzeigen",
  followUpFailed:
    "Das Ergebnis ließ sich nicht an den Agenten zurückgeben. Lies es hier.",
  approve: "Freigeben",
  decline: "Ablehnen",
  cancel: "Abbrechen",
  listTitle: "Fragen und Aufgaben",
  listHint:
    "Was dieser Agent seine Mitglieder gefragt oder ihnen übergeben hat, offene zuerst. Antworten stehen auch in den Chats der Mitglieder.",
  open: (count) => `Offen (${count})`,
  finished: (count) => `Abgeschlossen (${count})`,
  none: "Dieser Agent hat seinen Mitgliedern noch nichts geschickt.",
  answer: "Antwort",
  result: "Ergebnis",
  because: (quote) => `Weil du geschrieben hast: „${quote}“`,
};
