export const assistantProactivityCopy = {
  title: "Von sich aus handeln",
  intro:
    "Optionale Wege, auf denen der Agent ohne Auftrag tätig wird. Alles hier ist aus, bis du es einschaltest.",
  heartbeat: "Sich von selbst melden",
  heartbeatDescription:
    "Zu festen Zeiten liest der Agent seine Unterhaltung und Notizen und entscheidet, ob etwas deine Aufmerksamkeit braucht. Nur dann schreibt er in seinen Chat, der auch deinen verbundenen Telegram-Chat erreicht.",
  heartbeatNeedsMemory: "Braucht das oben eingeschaltete Gedächtnis.",
  heartbeatChannel: "Braucht einen verbundenen Telegram-Chat für diesen Agenten.",
  heartbeatReply:
    "Meldungen erscheinen im Chat des Agenten, auf Telegram mit „Check-in:“ markiert, sodass du direkt antworten kannst. Wird eine Meldung fällig, während der Agent antwortet, wartet sie, bis er fertig ist.",
  interval: "Wie oft",
  intervals: {
    "1h": "Jede Stunde",
    "2h": "Alle 2 Stunden",
    "4h": "Alle 4 Stunden",
    daily: "Einmal am Tag",
  },
  activeFrom: "Aktiv von",
  activeUntil: "Aktiv bis",
  hour: (hour) => `${String(hour).padStart(2, "0")}:00`,
  timeZone: (zone) => `Zeiten in ${zone}, innerhalb eines Tages.`,
  adoptZone: (zone) => `Meine Zeitzone verwenden (${zone})`,
  heartbeatCost: (runs) =>
    runs === 1
      ? "Etwa 1 zusätzlicher Modelllauf pro Tag, jeweils mit der ganzen Unterhaltung."
      : `Etwa ${runs} zusätzliche Modellläufe pro Tag, jeweils mit der ganzen Unterhaltung.`,
};
