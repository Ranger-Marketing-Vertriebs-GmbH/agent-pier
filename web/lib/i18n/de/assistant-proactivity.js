export const assistantProactivityCopy = {
  title: "Von sich aus handeln",
  intro:
    "Optionale Wege, auf denen der Agent ohne Auftrag tätig wird. Alles hier ist aus, bis du es einschaltest.",
  recall: "Über Unterhaltungen hinweg erinnern",
  recallDescription:
    "Durchsucht vor dem Antworten eigene frühere Unterhaltungen dieses Agenten, etwa zwischen AgentPier und Telegram. Nie die eines anderen Agenten.",
  recallNeedsMemory: "Braucht das oben eingeschaltete Gedächtnis.",
  recallCost:
    "Eine Nachricht, die sich auf frühere Unterhaltungen bezieht, kann ein bis zwei zusätzliche Modellaufrufe kosten.",
  heartbeat: "Sich von selbst melden",
  heartbeatDescription:
    "Zu festen Zeiten prüft der Agent, ob etwas deine Aufmerksamkeit braucht. Er schreibt deinem verbundenen Telegram-Chat nur, wenn er etwas zu sagen hat.",
  heartbeatChannel: "Braucht einen verbundenen Telegram-Chat für diesen Agenten.",
  interval: "Wie oft",
  intervals: {
    "1h": "Jede Stunde",
    "2h": "Alle 2 Stunden",
    "4h": "Alle 4 Stunden",
    daily: "Einmal am Tag",
  },
  activeFrom: "Aktiv von",
  activeUntil: "bis",
  hour: (hour) => `${String(hour).padStart(2, "0")}:00`,
  timeZone: (zone) => `Zeiten in deiner Zeitzone (${zone}).`,
  heartbeatCost: (runs) =>
    runs === 1
      ? "Etwa 1 zusätzlicher Modelllauf pro Tag."
      : `Etwa ${runs} zusätzliche Modellläufe pro Tag.`,
};
