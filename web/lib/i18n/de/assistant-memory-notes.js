// Ruhige Chatzeilen, wenn das Gedächtnis eines Agenten nicht geschrieben wurde.
export const memoryNoteCopy = {
  reasons: {
    "guard-pending":
      "Gedächtnis für diese Nachricht schreibgeschützt: Der Schreibschutz startet noch.",
    "not-owner":
      "Gedächtnis nicht gespeichert: Nur deine eigenen Nachrichten können das Gedächtnis ändern.",
    "lead-request":
      "Gedächtnis nicht gespeichert: Aufgaben des leitenden Agenten können das Gedächtnis nicht ändern.",
    flush:
      "Gedächtnis nicht gespeichert: Die automatische Notiz vor dem Kürzen der Unterhaltung wurde abgelehnt.",
  },
  unknown: "Gedächtnis nicht gespeichert.",
};
