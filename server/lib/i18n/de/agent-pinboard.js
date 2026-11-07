/** Owner-facing copy of the agent pinboard (assistantProblem keys). */
export const agentPinboard = Object.freeze({
  pinboardListNotFound: "Diese Pinnwand-Liste gibt es nicht.",
  pinboardEntryNotFound: "Diesen Pinnwand-Eintrag gibt es nicht.",
  pinboardListLimit: (max) =>
    `Die Pinnwand hat schon die meisten erlaubten offenen Listen (${max}). Archiviere oder lösche zuerst eine.`,
  pinboardEntryLimit: (max) =>
    `Diese Liste hat schon die meisten erlaubten Einträge (${max}). Entferne zuerst einen.`,
  pinboardOwnerOnly: "Nur der Besitzer kann die Pinnwand eines Agenten nutzen.",
  pinboardUnavailable: "Die Pinnwand ist gerade nicht verfügbar.",
});
