export const releaseCopy = Object.freeze({
  notPublished:
    "Noch kein installierbares Release verfügbar. Bitte später erneut nach Updates suchen.",
  invalidVersion: "Ungültige Release-Version.",
  incompatible: "Plattform oder Datenschema des Releases ist nicht kompatibel.",
  incompatibleRollback: "Plattform oder Schema des Releases ist nicht kompatibel.",
  downloadLimit: "Der Release-Download überschreitet sein Limit.",
  invalidArchive: "Ungültiges Release-Archiv.",
  unsupportedArchive: "Nicht unterstütztes Release-Archiv.",
  layoutMissing: (required) => `Im Release fehlt ${required}.`,
  manifestsDisagree: "Die Release-Manifeste stimmen nicht überein.",
  smokeFailed:
    "Die Smoke-Prüfung der Release-Laufzeit oder der nativen Abhängigkeiten ist fehlgeschlagen.",
  pointerNotOwned: "Der Release-Zeiger muss ein eigener symbolischer Link sein.",
  stableDataRequired: "Ein stabiler Datenordner außerhalb der Releases ist erforderlich.",
  launcherLinked: "Der Starter darf kein symbolischer Link sein.",
  activationDataRequired:
    "Die Release-Aktivierung benötigt einen stabilen externen Datenordner.",
  stagedNotFound: "Das bereitgestellte Release wurde nicht gefunden.",
  directoryLinked: "Der Release-Ordner darf kein Link sein.",
  initialReleaseRequired:
    "Bitte vor der Aktivierung das erste versionierte Release installieren.",
  pointerOutside: "Der Release-Zeiger liegt außerhalb seiner eigenen Struktur.",
  alreadyActive: "Dieses Release ist bereits aktiv.",
  activationPending:
    "Eine andere Release-Aktivierung steht noch aus. Bitte vor einem neuen Versuch prüfen.",
  healthFailed: "Die Zustandsprüfung des Releases ist fehlgeschlagen.",
  healthFailedSchema:
    "Die Zustandsprüfung des Releases ist nach einer Schemaänderung fehlgeschlagen; ein automatisches Zurücksetzen ist nicht kompatibel, die neuen Daten bleiben erhalten.",
  healthFailedRestored:
    "Die Zustandsprüfung des Releases ist fehlgeschlagen; das vorherige Release wurde wiederhergestellt.",
  healthFailedRecovery:
    "Die Zustandsprüfung des Releases ist fehlgeschlagen; der vorherige Zeiger wurde wiederhergestellt, aber der Dienst muss geprüft werden.",
  activationFailed:
    "Die Release-Aktivierung ist vor einem geprüften Ergebnis fehlgeschlagen.",
  schemaUnverifiable: "Das Datenschema kann nicht sicher geprüft werden.",
  schemaUnreadable:
    "Das Release kann das aktuelle Datenschema nicht lesen; ein Zurücksetzen erfordert eine separate Wiederherstellung in ein neues Ziel.",
  serviceUnsupported: "Für diese Plattform gibt es keine unterstützte Dienstanbindung.",
  serviceRestartFailed: "Der AgentPier-Benutzerdienst konnte nicht neu gestartet werden.",
  noMigration: "Für dieses Release läuft keine Migration.",
  migrateBusy:
    "Ein anderer Release-Vorgang läuft. Bitte warten, bis er abgeschlossen ist.",
  migrateCancelled: "Die Migration wurde abgebrochen. Das Release bleibt erhalten.",
  migrateInterrupted: "Der Webdienst wird beendet. Das Release bleibt erhalten.",
  migrateChanged:
    "Die Sitzungen dieses Releases haben sich geändert. Bitte die Liste aktualisieren.",
  migrateFailed:
    "Einige Sitzungen konnten nicht neu geladen werden. Das Release bleibt erhalten.",
  reloadCancelled: "Das Neuladen wurde vor dem Abschluss abgebrochen.",
  cleanupUnavailable: "Das Release steht nicht mehr zum Aufräumen zur Verfügung.",
  cleanupStateChanged:
    "Das Release lässt sich in seinem aktuellen Zustand nicht mehr aufräumen. Bitte die Liste aktualisieren.",
  migrateBlocked: "Prozesse verwenden dieses Release noch. Das Release bleibt erhalten.",
  cleanupInvalid: "Ungültige Auswahl zum Aufräumen von Releases.",
  cleanupBusy: "Ein anderer Release-Vorgang steht noch aus.",
  cleanupChanged:
    "Die ausgewählten Releases können nicht mehr sicher entfernt werden. Bitte die Liste aktualisieren.",
  httpsDownloadRequired:
    "Release-Downloads erfordern HTTPS ohne eingebettete Zugangsdaten.",
  redirectLimit: "Zu viele Weiterleitungen beim Release-Download.",
  downloadFailed: "Der Release-Download ist fehlgeschlagen.",
  channelRequired: "Bitte zuerst auf dem Server einen HTTPS-Release-Kanal einrichten.",
  channelHttpsRequired:
    "Der Release-Kanal muss HTTPS ohne eingebettete Zugangsdaten verwenden.",
  channelManifestInvalid: "Das Manifest des Release-Kanals ist ungültig.",
  artifactIncompatible: "Das Release-Paket fehlt oder ist nicht kompatibel.",
  installRootRequired:
    "Bitte vor dem Bereitstellen eines Releases einen Installationsordner einrichten.",
  dataInsideReleases:
    "Der Datenordner muss außerhalb der versionierten Release-Ordner liegen.",
  noNewerVersion: "Der Release-Kanal bietet keine neuere Version an.",
  channelChanged:
    "Der Release-Kanal hat sich geändert; bitte den neuen Kandidaten prüfen.",
  checksumMismatch: "Die Release-Prüfsumme stimmt nicht überein.",
  versionMismatch: "Die Version des Release-Archivs passt nicht zur Auswahl.",
  alreadyExists: "Dieses unveränderliche Release existiert bereits.",
  versionedInstallRequired: "Eine versionierte Installation ist erforderlich.",
  versionedInstallMissing:
    "Bitte vor dem Aktivieren von Updates mit dem Release-CLI eine versionierte Installation anlegen.",
});
