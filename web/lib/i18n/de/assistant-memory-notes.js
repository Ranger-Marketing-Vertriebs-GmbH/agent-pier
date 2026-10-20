// Ruhige Chatzeilen, wenn das Gedächtnis eines Agenten nicht geschrieben wurde oder
// ein Eintrag im Gedächtnis eines geteilten Agenten für alle gilt.
export const memoryNoteCopy = {
  reasons: {
    "guard-pending":
      "Gedächtnis für diese Nachricht schreibgeschützt: Der Schreibschutz startet noch.",
    "not-owner":
      "Gedächtnis nicht gespeichert: Nur deine eigenen Nachrichten können das Gedächtnis ändern.",
    forwarded:
      "Gedächtnis nicht gespeichert: Weitergeleitete Inhalte können das Gedächtnis nicht ändern.",
    automatic:
      "Gedächtnis nicht gespeichert: Geplante und automatische Durchläufe können das Gedächtnis nicht ändern.",
    "lead-request":
      "Gedächtnis nicht gespeichert: Aufgaben des leitenden Agenten können das Gedächtnis nicht ändern.",
    flush:
      "Gedächtnis nicht gespeichert: Die automatische Notiz vor dem Kürzen der Unterhaltung wurde abgelehnt.",
    "shared-write": "Gilt für alle, die diesen Agenten nutzen.",
  },
  unknown: "Gedächtnis nicht gespeichert.",
};
