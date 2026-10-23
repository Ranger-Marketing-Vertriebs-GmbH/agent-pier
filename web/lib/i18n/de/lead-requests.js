// Fragen und Aufgaben eines leitenden Agenten an seine eigenen Teammitglieder.
export const leadRequestCopy = {
  // Die Meta-Zeile unter einer Nachricht, die der leitende Agent geschickt hat.
  from: (name) => `von ${name}`,
  at: (from, time) => `${from} · ${time}`,
  spokenAt: (from, time) => `${from}, ${time}`,
  permanentSection: "Dauerhaft",
  temporarySection: "Temporär",
  title: (type, member) =>
    type === "task"
      ? `Aufgabe für ${member}`
      : type === "report"
        ? `Routinebericht von ${member}`
        : `Frage an ${member}`,
  // Die Frage oder Aufgabe eines Mitglieds an ein anderes Mitglied desselben Leads.
  peerTitle: (type, from, to) =>
    `${from} → ${to} · ${type === "task" ? "Aufgabe" : "Frage"}`,
  // Ein eigener Bericht eines Mitglieds an seinen leitenden Agenten.
  reportTitle: (kind, member) =>
    kind === "problem" ? `Problem von ${member}` : `Ergebnis von ${member}`,
  // Das fragende Mitglied lässt das Ergebnis an den Lead statt an sich selbst gehen.
  toLead: "Ergebnis an den leitenden Agenten",
  // Leise Zeilen im Chat des Leads, wenn ein Austausch unter Mitgliedern beginnt und endet.
  peerNote: {
    started: (type, from, to) =>
      type === "task"
        ? `${from} hat ${to} eine Aufgabe gegeben`
        : `${from} hat ${to} eine Frage gestellt`,
    completed: (type, from, to) =>
      type === "task"
        ? `${to} hat die Aufgabe von ${from} erledigt`
        : `${to} hat ${from} geantwortet`,
    failed: (type, from, to) =>
      type === "task"
        ? `${to} konnte die Aufgabe von ${from} nicht erledigen`
        : `${to} konnte ${from} nicht antworten`,
    cancelled: (type, from, to) =>
      type === "task"
        ? `Die Aufgabe von ${from} an ${to} wurde abgebrochen`
        : `Die Frage von ${from} an ${to} wurde abgebrochen`,
  },
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
  // Der Lead hat sie von sich aus gestartet (Team-Nutzung „Selbstständig“).
  selfInitiated: "selbst gestartet",
  // Eine Routine des Leads hat sie gestellt; ihre Aufgaben dürfen nie schreiben.
  routine: (name) => (name ? `Geplant · ${name}` : "Geplant"),
  showAll: "Alles anzeigen",
  // An answer stored incomplete beyond the history limit.
  answerShortened: "Gekürzt – der vollständige Text steht im Chat des Mitglieds.",
  openMemberChat: "Chat öffnen",
  followUpFailed:
    "Das Ergebnis ließ sich nicht an den Agenten zurückgeben. Lies es hier.",
  listTitle: "Fragen und Aufgaben",
  listHint:
    "Was dieser Agent seine Mitglieder gefragt oder ihnen übergeben hat, offene zuerst. Eine Aufgabe darf Dateien im Arbeitsbereich des Mitglieds nur ändern, wenn du sie selbst verlangt hast oder wenn der Agent sein Team selbstständig nutzt und sie als Antwort auf deine Nachricht gestartet hat (markiert als selbst gestartet). Antworten stehen auch in den Chats der Mitglieder. Auch der Austausch unter Mitgliedern und ihre eigenen Berichte stehen hier.",
  open: (count) => `Offen (${count})`,
  finished: (count) => `Abgeschlossen (${count})`,
  none: "Dieser Agent hat seinen Mitgliedern noch nichts geschickt.",
  answer: "Antwort",
  result: "Ergebnis",
  report: "Bericht",
  because: (quote) => `Weil du geschrieben hast: „${quote}“`,
  // Die @Erwähnung im Eingabefeld eines leitenden Agenten und die Chips im Chat.
  mentions: {
    list: "Teammitglieder",
    permanent: "Dauerhaft",
    temporary: "Temporär",
    open: (name) => `Chat mit ${name} öffnen`,
  },
};
