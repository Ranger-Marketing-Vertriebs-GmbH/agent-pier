export const fileTransfersCopy = {
  actions: {
    archive: "ZIP erstellen",
    download_zip: "Als ZIP herunterladen",
    download_folder: "Diesen Ordner als ZIP herunterladen",
    extract_here: "Hier entpacken",
    extract_to: "In Ordner entpacken …",
  },
  target: "Zielordner",
  archivePolicy:
    "Der Server prüft die Auswahl vor dem Erstellen der ZIP. Ausgelassene Links erfordern die Prüfung und Bestätigung der vollständigen Liste. Spezialdateien werden ausgelassen und in den Einzelergebnissen angezeigt.",
  extractPolicy:
    "Reguläre Dateien und Ordner aus dieser ZIP entpacken. Vorhandene Einträge erfordern eine Entscheidung. Nicht unterstützte Namen, Links, verschlüsselte Einträge und konfigurierte Grenzen können das Entpacken stoppen.",
  sameAttempt:
    "Erneut bestätigen, um dieselbe Anfrage zu prüfen. Nach einer verlorenen Antwort bleiben ihre Auswahl und Anfragekennung unverändert.",
  unknownRequest: "Das Ergebnis dieser Anfrage ist unbekannt.",
  checkRequest: "Bestehende Anfrage prüfen",
  preparing: "Archiv wird vorbereitet …",
  publicationPolicy:
    "Der Vorbereitungsfortschritt kann sich ändern. Die endgültigen Dateiergebnisse zeigen, was fertig ist und was übersprungen wurde.",
  retainedResults:
    "Fertige Ergebnisse bleiben erhalten. Unfertige oder ungewisse Einträge müssen geprüft werden; eine Unterbrechung setzt sie nicht automatisch fort.",
  noneExtracted:
    "Es wurden keine Einträge entpackt. Die übersprungenen oder leeren Ergebnisse prüfen.",
  unknown: "unbekannt",
  entries: (completed, total) => `${completed} von ${total} Einträgen abgeschlossen`,
  bytes: (completed, total) => `${completed} von ${total} Bytes verarbeitet`,
  downloadArchive: "Archiv herunterladen",
  artifactUnavailable:
    "Für dieses Archiv ist kein Download verfügbar. Seine gespeicherten Vorgangsergebnisse garantieren nicht, dass das Archiv noch existiert.",
  history: "Seiten des Vorgangsverlaufs",
  nextJobs: "Nächste Vorgänge",
  previousJobs: "Vorherige Vorgänge",
  showResults: "Einzelergebnisse laden",
  nextEntries: "Nächste Ergebnisseite laden",
  outcomeUnknown: "Abschluss ist nicht nachgewiesen",
  omissionsTitle: "Ausgelassene Einträge prüfen",
  omissionsPolicy:
    "Diese Links und Spezialdateien werden nicht aufgenommen. Die Zustimmung gilt nur für diese vollständige, geprüfte Archivauswahl; eine geänderte Auswahl erfordert eine neue Prüfung.",
  loadingOmissions: "Alle Auslassungsseiten werden geladen und geprüft …",
  omissionsCount: (count) => `${count} Einträge werden ausgelassen.`,
  omissionsConsent:
    "Ich habe die vollständige Liste geprüft und akzeptiere diese Auslassungen.",
  continueOmissions: "ZIP mit diesen Auslassungen erstellen",
  reloadOmissions: "Auslassungsprüfung neu laden",
  reviewRetry: "Wiederholung prüfen",
  retryTitle: "Unfertige Einträge wiederholen",
  retryPolicy:
    "Nur die unten angezeigte, vom Server geprüfte Auswahl wird als neue Anfrage wiederholt. Der ursprüngliche Vorgang und seine fertigen Ergebnisse bleiben unverändert. Ungeklärte Wiederherstellungsnachweise verhindern eine Wiederholung.",
  loadingRetry: "Quellreferenzen und gespeicherte Ergebnisse werden geprüft …",
  retryCount: (count) =>
    `${count} wiederholbare Einträge in dieser vollständigen Auswahl.`,
  confirmRetry: "Neue Wiederholung bestätigen",
};
