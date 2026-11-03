// Die Karte für den Besitzer nach der Gedächtnisprüfung eines Modellwechsels und das
// Archiv auf der Gedächtnis-Seite (memory-reviews.js, memory-archive.js).
export const memoryReviewCopy = {
  title: "Gedächtnis nach dem Modellwechsel",
  switched: (from, to) => `Von ${from} zu ${to}`,
  hint: "Ein früheres Modell hat diese Einträge über das geschrieben, was es selbst abgelehnt oder sich als Grenze gesetzt hat. Archivieren nimmt einen Eintrag aus dem Gedächtnis des Agenten; auf der Gedächtnis-Seite kannst du ihn wiederherstellen. Bis du anwendest, bleibt das Gedächtnis, wie es ist.",
  entries: (count) => (count === 1 ? "1 Eintrag" : `${count} Einträge`),
  choice: (file) => `Eintrag in ${file}`,
  archive: "Archivieren",
  keep: "Behalten",
  apply: "Anwenden",
  applied: (archived, kept, changed) =>
    [
      `${archived} archiviert`,
      `${kept} behalten`,
      changed ? `${changed} inzwischen geändert und im Gedächtnis geblieben` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  archiveTitle: "Archiv",
  archiveHint:
    "Einträge, die du nach einem Modellwechsel aus dem Gedächtnis des Agenten genommen hast. Der Agent liest sie nicht. Wiederherstellen hängt einen Eintrag wieder ans Ende seiner Datei.",
  archiveEmpty: "Keine archivierten Einträge.",
  restore: "Wiederherstellen",
  archived: (date) => `Archiviert am ${date}`,
};
