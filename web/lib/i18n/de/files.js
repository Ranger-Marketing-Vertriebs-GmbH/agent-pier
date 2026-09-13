export const filesCopy = {
  errors: {
    FILE_OUTSIDE_SCOPE: "Dieser Pfad liegt außerhalb des Projektverzeichnisses.",
    FILE_INVALID_PATH: "Dieser Dateipfad ist ungültig.",
    FILE_INVALID_NAME: "Dieser Name ist ungültig oder zu lang.",
    FILE_NOT_FOUND: "Die Datei oder der Ordner wurde nicht gefunden.",
    FILE_NOT_DIRECTORY: "Dieser Pfad ist kein Ordner.",
    FILE_LINK_LOOP: "Diese Verknüpfung kann wegen einer Schleife nicht aufgelöst werden.",
    FILE_ACCESS_DENIED: "Du hast keine Zugriffsrechte für diesen Eintrag.",
    FILE_IO_ERROR: "Die Dateioperation konnte nicht abgeschlossen werden.",
    FILE_INVALID_SCOPE: "Der Dateizugriffskontext ist ungültig.",
    FILE_READ_ONLY: "Dateien in diesem Kontext können nur gelesen werden.",
    FILE_PROTECTED_PATH: "Dieser Ordner ist vor Dateioperationen geschützt.",
    FILE_PATH_CHANGED:
      "Der Ordner wurde geändert. Aktualisiere die Auswahl und versuche es erneut.",
    FILE_INVALID_LIMITS: "Die konfigurierten Dateigrenzen sind ungültig.",
    FILE_INVALID_PAGE: "Diese Dateilistenseite ist ungültig.",
    FILE_INVALID_SORT: "Diese Sortierung der Dateiliste ist ungültig.",
    FILE_SNAPSHOT_EXPIRED: "Diese Dateiliste ist abgelaufen. Aktualisiere sie erneut.",
    FILE_LIMIT_EXCEEDED:
      "Die Dateioperation hat ihre konfigurierte Grenze überschritten.",
    FILE_UNSUPPORTED_TYPE: "Dieser Dateityp kann nicht als Vorschau angezeigt werden.",
    FILE_INVALID_RESPONSE: "Der Dateidienst hat eine ungültige Antwort gesendet.",
  },
  requestFailed: (status) => `Dateianfrage fehlgeschlagen (${status}).`,
  tab: "Dateien",
  root: "Projektordner",
  up: "Übergeordneter Ordner",
  loading: "Dateien werden geladen …",
  empty: "Dieser Ordner ist leer.",
  previous: "Vorherige Dateien",
  next: "Weitere Dateien",
  close: "Vorschau schließen",
  preview: "Dateivorschau",
  error: "Dateien konnten nicht geladen werden.",
  summary: (total, page) => `${total} Einträge · Seite ${page}`,
};

export const fileErrorMessage = (code, status) =>
  filesCopy.errors[code] || filesCopy.requestFailed(status);
