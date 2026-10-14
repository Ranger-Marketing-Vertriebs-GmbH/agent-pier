export const routineCopy = {
  title: "Routinen",
  description:
    "Speichere eine Aufgabe, die täglich oder bei einem Ereignis ein neues Ergebnis erstellt. Ergebnisse gehen an den gekoppelten Telegram-Chat und erscheinen im Chat dieses Agenten. Routinen nutzen die Werkzeuge und Freigaben des Agenten, können aber nichts planen, delegieren oder Dateien ändern.",
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
  chatFailed: (name) =>
    name
      ? `Routine „${name}“ konnte nicht abgeschlossen werden.`
      : "Eine Routine konnte nicht abgeschlossen werden.",
};
