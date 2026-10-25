export const routineCopy = {
  title: "Routinen",
  description:
    "Speichere eine Aufgabe, die täglich oder bei einem Ereignis ein neues Ergebnis erstellt. Ergebnisse erscheinen im Chat dieses Agenten, mit Push-Benachrichtigung. Routinen nutzen die Tools und Freigaben des Agenten, können aber nichts planen oder delegieren. Sie lesen die letzten Nachrichten des Chats, auch weitergeleitete, und laufen, ohne dass jemand zusieht. Mit vollem Shell-Zugriff handeln sie also ohne Rückfrage.",
  name: "Routinenname",
  prompt: "Aufgabenbeschreibung",
  trigger: "Routinenauslöser",
  daily: "Täglich",
  event: "Bei Ereignis",
  eventKind: "Routinenereignis",
  manual: "Anfrage des Eigentümers",
  codingCompleted: "Verknüpfter Coding-Lauf abgeschlossen",
  time: "Routinenzeit",
  timezone: "Routinenzeitzone",
  create: "Routine erstellen",
  pause: "Routine pausieren",
  resume: "Routine fortsetzen",
  remove: "Routine entfernen",
  run: "Einmal ausführen",
  empty: "Noch keine Routinen.",
  unknownName: "Routine",
  invalidTime: "Gib eine gültige Uhrzeit und Zeitzone ein.",
  states: {
    active: "Aktiv",
    paused: "Pausiert",
    unknown: "Ausgang unklar",
    failed: "Fehlgeschlagen",
    removed: "Entfernt",
  },
  events: {
    queued: "Ausführung eingereiht.",
    rejected: "Ausführung nicht gestartet. Die Routine läuft möglicherweise bereits.",
    unknown: "Startausgang unklar. Dieses Ereignis wird nicht automatisch wiederholt.",
  },
  scheduled: "Nach Zeitplan",
  dailyAt: (time, timezone) => `Täglich um ${time} (${timezone})`,
  nextRun: (time) => `Nächste Ausführung: ${time}`,
  // Marks a routine's result in the agent's chat; a failed run is a quiet line.
  chatBadge: (name) => (name ? `Geplant · ${name}` : "Geplant"),
  checkInBadge: "Check-in",
  sshRefused: "SSH abgelehnt: Host ist für Routinen nicht freigegeben",
  chatFailed: (name) =>
    name
      ? `Routine „${name}“ konnte nicht abgeschlossen werden.`
      : "Eine Routine konnte nicht abgeschlossen werden.",
  reminderFailed: (name) =>
    name
      ? `Erinnerung „${name}“ konnte nicht ausgeführt werden.`
      : "Eine Erinnerung konnte nicht ausgeführt werden.",
  alsoTelegram: "Auch an Telegram senden",
  writes: "Darf schreiben",
  writesHint: "Projektordner und delegierte Aufgaben",
  writesOn: "Darf schreiben",
  telegramOn: "Wird auch an Telegram gesendet",
  edit: "Routine bearbeiten",
  save: "Routine speichern",
  // Eine Routine, die der leitende Agent des Mitglieds angelegt hat (Team-Tool).
  createdBy: (lead) => (lead ? `Angelegt von ${lead}` : "Angelegt vom leitenden Agenten"),
  leadHint: (lead) =>
    `${lead || "Der leitende Agent"} hat diese Routine angelegt. Ihre Ergebnisse gehen auch an ${lead || "den leitenden Agenten"}. Sie liest nur, solange du „Darf schreiben“ nicht einschaltest oder der leitende Agent sein Team nicht selbstständig nutzt.`,
  // Warum ein Lauf fehlschlug (Server routine-failures.js); OpenClaws Meldung ist das Detail.
  failures: {
    "gateway-restart": "Das Gateway wurde während des Laufs neu gestartet.",
    "gateway-stopped": "Das Gateway wurde während des Laufs beendet.",
    "agent-unavailable": "Der Agent war nicht verfügbar.",
    timeout: "Der Lauf hat zu lange gedauert und wurde abgebrochen.",
    model: "Der Modellanbieter hat einen Fehler gemeldet.",
    delivery: "Das Ergebnis konnte nicht zugestellt werden.",
    other: "Der Lauf ist fehlgeschlagen.",
  },
  lastRunFailed: "Letzter Lauf fehlgeschlagen",
  failedInARow: (count) => `${count} Läufe in Folge fehlgeschlagen`,
  failureMessage: "Fehlermeldung",
  copyFailure: "Fehlermeldung kopieren",
  noFailureMessage: "OpenClaw hat keine Fehlermeldung gemeldet.",
  runAt: "Zeitpunkt",
  duration: "Dauer",
  seconds: (value) => `${value} s`,
  history: "Laufverlauf",
  hideHistory: "Laufverlauf ausblenden",
  noRuns: "Noch keine Läufe.",
  runOk: "Abgeschlossen",
};
