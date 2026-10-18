export const assistantProactivityCopy = {
  title: "Von sich aus handeln",
  intro:
    "Optionale Wege, auf denen der Agent ohne Auftrag tätig wird. Alles hier ist aus, bis du es einschaltest.",
  heartbeat: "Sich von selbst melden",
  heartbeatDescription:
    "Zu festen Zeiten liest der Agent seine Unterhaltung und Notizen und entscheidet, ob etwas deine Aufmerksamkeit braucht. Nur dann schreibt er in seinen Chat und du bekommst eine Push-Benachrichtigung.",
  alsoTelegram: "Auch an Telegram senden",
  heartbeatReply:
    "Meldungen erscheinen im Chat des Agenten, mit „Check-in“ markiert, sodass du direkt antworten kannst. Wird eine Meldung fällig, während der Agent antwortet, erscheint sie nach dieser Antwort und kennt sie womöglich noch nicht.",
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
      ? "Etwa 1 zusätzlicher Modelllauf pro Tag, jeweils mit dem letzten Teil der Unterhaltung."
      : `Etwa ${runs} zusätzliche Modellläufe pro Tag, jeweils mit dem letzten Teil der Unterhaltung.`,
};
