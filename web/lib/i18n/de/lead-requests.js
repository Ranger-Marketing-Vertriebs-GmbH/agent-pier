// Fragen und Aufgaben eines leitenden Agenten an seine eigenen Teammitglieder.
export const leadRequestCopy = {
  // Die Meta-Zeile unter einer Nachricht, die der leitende Agent geschickt hat.
  from: (name) => `von ${name}`,
  at: (from, time) => `${from} · ${time}`,
  spokenAt: (from, time) => `${from}, ${time}`,
  permanentSection: "Dauerhaft",
  temporarySection: "Temporär",
  title: (type, member) =>
    type === "task" ? `Aufgabe für ${member}` : `Frage an ${member}`,
  states: {
    queued: "Wartet auf das Mitglied",
    dispatching: "Wird gesendet",
    running: "In Arbeit",
    uncertain: "Ausgang unklar",
    completed: "Erledigt",
    answered: "Beantwortet",
    failed: "Fehlgeschlagen",
    cancelled: "Abgebrochen",
  },
  // Eine Aufgabe darf nur schreiben, wenn der Besitzer sie ausdrücklich verlangt hat.
  mayWrite: "darf schreiben",
  readOnly: "nur lesen",
  showAll: "Alles anzeigen",
  followUpFailed:
    "Das Ergebnis ließ sich nicht an den Agenten zurückgeben. Lies es hier.",
  cancel: "Abbrechen",
  listTitle: "Fragen und Aufgaben",
  listHint:
    "Was dieser Agent seine Mitglieder gefragt oder ihnen übergeben hat, offene zuerst. Eine Aufgabe darf Dateien im Arbeitsbereich des Mitglieds nur ändern, wenn du sie selbst verlangt hast. Antworten stehen auch in den Chats der Mitglieder.",
  open: (count) => `Offen (${count})`,
  finished: (count) => `Abgeschlossen (${count})`,
  none: "Dieser Agent hat seinen Mitgliedern noch nichts geschickt.",
  answer: "Antwort",
  result: "Ergebnis",
  because: (quote) => `Weil du geschrieben hast: „${quote}“`,
  // Die @Erwähnung im Eingabefeld eines leitenden Agenten und die Chips im Chat.
  mentions: {
    list: "Teammitglieder",
    permanent: "Dauerhaft",
    temporary: "Temporär",
    open: (name) => `Chat mit ${name} öffnen`,
  },
};
