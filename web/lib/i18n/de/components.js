export const paginationCopy = {
  listPaginationAriaLabel: (value1) => `${value1}: Seiten`,
  totalCountPrefix: " von ",
  previousPageLabel: (value1) => `${value1}: Vorherige Seite`,
  pageNumberPrefix: "Seite ",
  nextPageLabel: (value1) => `${value1}: Nächste Seite`,
};
export const apiCopy = {
  requestFailed: (value1) => `Anfrage fehlgeschlagen (${value1})`,
};
export const imageViewerCopy = {
  title: "Bildansicht",
  close: "Bildansicht schließen",
  download: "Herunterladen",
  share: "Teilen",
  missing: "Bild nicht mehr verfügbar.",
};
export const fileLinkCopy = {
  failed: "Die Datei konnte nicht gesichert werden.",
  title: "Datei sichern",
  tap: "Tippen zum Sichern",
};
export const copyButtonCopy = {
  copied: "Kopiert",
  failed: "Kopieren fehlgeschlagen. Markiere den Text und kopiere ihn manuell.",
};
export const addPickerCopy = {
  placeholder: (type) => `${type} hinzufügen …`,
  fieldLabel: (type) => `${type} hinzufügen`,
  listLabel: (type) => `${type}: Auswahl`,
  matches: (count) => `${count} Treffer`,
  noMatches: "Keine Treffer",
  searching: "Suche …",
  searchFailed:
    "Die Suche ist fehlgeschlagen. Ändere die Eingabe, um es erneut zu versuchen.",
  alreadyGranted: "hat er schon",
  more: (count) => `${count} weitere – Suche verfeinern`,
  mode: "Modus",
  modeLabel: "Modus für neue Einträge",
  add: (count) => (count > 0 ? `${count} hinzufügen` : "Hinzufügen"),
};
