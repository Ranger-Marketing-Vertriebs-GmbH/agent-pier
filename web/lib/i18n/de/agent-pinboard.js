// Die Pinnwand eines Agenten in der Owner-App: Dateien, die der Agent für den Owner
// angeheftet hat, in Listen (web/features/assistants/pinboard/).
export const agentPinboardCopy = {
  title: "Pinnwand",
  chat: "Chat",
  tabWithCount: (n) => (n > 0 ? `Pinnwand (${n})` : "Pinnwand"),
  switchLabel: "Chat oder Pinnwand",
  open: "Pinnwand öffnen",
  close: "Pinnwand schließen",
  empty:
    "Noch nichts angeheftet. Dateien, die dein Agent für dich anheftet, erscheinen hier.",
  from: (chat) => `aus ${chat}`,
  archived: (title) => `${title} · abgeschlossen`,
  archivedGroup: "Abgeschlossen",
  fresh: "NEU",
  unavailable: "Nicht mehr verfügbar",
  kinds: {
    text: "Text",
    video: "Video",
    image: "Bild",
    audio: "Audio",
    page: "Seite",
    file: "Datei",
  },
  // Die kompakte Kopfzeile des Agentenchats: Sheet des Arbeitsziels, Ereignisse.
  header: {
    workSheet: "Arbeitsziel",
    events: (n) => `Ereignisse: ${n}`,
  },
  reader: {
    position: (i, n) => `${i} von ${n}`,
    previous: "Zurück",
    next: "Weiter",
    back: "Zurück zu den Listen",
    download: "Herunterladen",
    empty: "Diese Datei ist nicht mehr verfügbar.",
    backToPage: "Zurück zur Seite",
    page: (name) => `Seite ${name}`,
  },
  loadFailed: "Die Pinnwand konnte nicht geladen werden.",
  card: {
    counts: {
      updated: (n) => (n === 1 ? "1 Datei aktualisiert" : `${n} Dateien aktualisiert`),
      added: (n) => `${n} hinzugefügt`,
      removed: (n) => `${n} entfernt`,
    },
    namesJoin: ", ",
    open: (title) => `Pinnwand-Liste ${title} öffnen`,
    gone: "gelöscht",
  },
  // The ⌘K search: the agent's pinboard entry ("<agent> · Pinnwand") and its alias.
  search: {
    pinboard: "Pinnwand",
    alias: "Angepinnte Dateien",
  },
};
