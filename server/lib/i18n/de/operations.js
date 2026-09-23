/** German browser-visible server messages, addressed through English semantic keys. */
export const operations = Object.freeze({
  invalidIdentifier: "Ungültige Vorgangskennung.",
  directoryLinked:
    "Der Vorgangsordner enthält einen Link oder ein Element, das kein Ordner ist.",
  directoryForeignOwner: "Der Vorgangsordner gehört einem anderen Benutzer.",
  invalidFile: "Ungültige Vorgangsdatei oder Größenlimit überschritten.",
  jobNotFound: "Vorgang nicht gefunden.",
  shuttingDown: "Die Vorgänge werden beendet.",
  webProcessRestarted:
    "Der Webprozess wurde neu gestartet, bevor dieser Vorgang abgeschlossen war. Bitte vor einem neuen Versuch die Ergebnisse prüfen.",
  releaseHelperSilent:
    "Der Release-Helfer meldet sich nicht mehr. Bitte vor einem neuen Versuch den Dienstzustand und den Release-Zeiger prüfen.",
  failedUnverified:
    "Der Vorgang ist fehlgeschlagen. Es wurde kein ungeprüftes Ergebnis übernommen.",
  uploadNotFound: "Das hochgeladene Archiv wurde nicht gefunden.",
  migrationRunning:
    "Eine Release-Migration läuft. Bitte warten, bis sie abgeschlossen ist.",
  invalidOptions: "Ungültige Vorgangsoptionen.",
  invalidDiagnosticScope: "Ungültiger Diagnoseumfang.",
  diagnosticProjectNotFound: "Das Projekt für die Diagnose wurde nicht gefunden.",
  unsafeDatabaseDirectory: "Unsicherer Speicherordner für die Datenbank.",
  unsafeDatabaseFile: "Unsichere Speicherdatei für die Datenbank.",
});
