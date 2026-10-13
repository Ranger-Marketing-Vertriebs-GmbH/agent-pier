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
