export const assistantDreamingCopy = {
  title: "Träumen",
  enable: "Nachts träumen",
  description:
    "Einmal pro Nacht geht jeder dauerhafte Agent mit seinem eigenen Modell seine eigenen Unterhaltungen durch, schreibt Traumnotizen und ein Traumtagebuch in sein Gedächtnis und darf MEMORY.md aufräumen (die letzten 7 Fassungen bleiben erhalten). Ein geteilter Agent geht die Chats all seiner Nutzer in sein geteiltes Gedächtnis durch, und seine Notizen können sie wörtlich zitieren. Temporäre Teammitglieder träumen auch.",
  hour: "Uhrzeit",
  timeZone: (zone) => `Uhrzeit in ${zone}.`,
  adoptZone: (zone) => `Meine Zeitzone verwenden (${zone})`,
  confirmTitle: "Gedächtnis für diese Agenten einschalten?",
  confirmBody: (count) =>
    count === 1
      ? "Träumen braucht Gedächtnis. 1 dauerhafter Agent merkt sich noch keine Informationen; es wird für ihn eingeschaltet."
      : `Träumen braucht Gedächtnis. ${count} dauerhafte Agenten merken sich noch keine Informationen; es wird für alle eingeschaltet.`,
  confirmAction: "Gedächtnis und Träumen einschalten",
  busy: (names) =>
    `Träumen bleibt aus: Für gerade arbeitende Agenten ließ sich das Gedächtnis nicht einschalten (${names}). Speichere erneut, wenn sie fertig sind.`,
  memoryLocked:
    "Träumen ist eingeschaltet: Jeder dauerhafte Agent behält sein Gedächtnis. Schalte es unter Agenten › Laufzeit › Träumen aus.",
  diary: "Traumtagebuch",
  diaryHint: "Vom nächtlichen Träumen des Agenten geschrieben. Nur lesbar.",
  moreNotes: (count) =>
    count === 1 ? "1 weitere Notiz laden" : `${count} weitere Notizen laden`,
};
