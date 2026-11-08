export const assistantDreamingCopy = {
  title: "Träumen",
  enable: "Nachts träumen",
  description:
    "Einmal pro Nacht geht jeder dauerhafte Agent mit seinem eigenen Modell seine eigenen Unterhaltungen durch. Ein OpenClaw-Agent schreibt Traumnotizen und ein Traumtagebuch in sein Gedächtnis und darf MEMORY.md aufräumen; ein Hermes-Agent führt MEMORY.md und USER.md zusammen, behält angeheftete Einträge wörtlich und hält jede Nacht in seinem Traumtagebuch fest. Die letzten 7 Fassungen bleiben erhalten. Ein geteilter Agent geht die Chats all seiner Nutzer in sein geteiltes Gedächtnis durch, und seine Notizen können sie wörtlich zitieren. Temporäre Teammitglieder träumen auch.",
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
  diaryTruncated: (size) =>
    `Das Traumtagebuch ist ${size} groß. Hier stehen nur seine neuesten Einträge, ältere sind abgeschnitten.`,
  entries: "Einträge",
  pinned: "Angeheftet",
  pin: (n) => `Eintrag ${n} anheften`,
  unpin: (n) => `Eintrag ${n} lösen`,
  room: (chars, limit, pinnedChars) =>
    `${chars} von ${limit} Zeichen, ${pinnedChars} angeheftet`,
  pinsHint: "Angeheftete Einträge bleiben beim Träumen des Agenten wörtlich erhalten.",
  nightApplied: "Gedächtnis zusammengeführt.",
  nightDiscarded: {
    pinLost: (file) =>
      `Verworfen: Ein angehefteter Eintrag in ${file} wäre verloren gegangen. Nichts wurde geändert.`,
    tooLarge: (file) =>
      `Verworfen: ${file} wäre über seiner Grenze gewesen. Nichts wurde geändert.`,
    unreadable:
      "Verworfen: Die Antwort des Agenten war nicht lesbar. Nichts wurde geändert.",
  },
  nightPostponed: (file) =>
    `Verschoben: ${file} hat sich während des Träumens geändert. Die nächste Nacht versucht es erneut.`,
  nightFailed:
    "Nicht geträumt: Der Agent oder sein Modell war nicht erreichbar. Die nächste Nacht versucht es erneut.",
  nightCounts: (file, { added, merged, replaced, dropped }) =>
    `${file}: ${added} hinzugefügt, ${merged} zusammengeführt, ${replaced} ersetzt, ${dropped} entfernt`,
};
