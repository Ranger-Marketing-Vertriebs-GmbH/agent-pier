/** Existing German product copy, addressed through English semantic keys. */
export const tools = Object.freeze({
  nativeUpdateRequired:
    "Für Updates ist eine native oder von AgentPier verwaltete npm-Installation erforderlich.",
  installationChanged: "Die CLI-Installation wurde während des Updates geändert.",
  cliUpdated:
    "CLI aktualisiert und geprüft. Neue oder neu geladene Sitzungen verwenden die aktualisierte Version.",
  invalidGithubRedirect: "Ungültige GitHub-Download-Weiterleitung.",
  forbiddenGithubRedirect: "GitHub-Download-Weiterleitung zu einem nicht erlaubten Ziel.",
  publicDownloadFailed: "Der öffentliche GitHub-Download ist fehlgeschlagen.",
  downloadHttpFailed: (status) =>
    `GitHub-Download fehlgeschlagen (HTTP ${status}). Bitte später erneut versuchen.`,
  downloadTooLarge: "Der GitHub-Download ist zu groß.",
  unsafeArchivePath: "Das Archiv enthält einen unsicheren Pfad.",
  archiveSizeExceeded: "Das Archiv überschreitet die zulässige Größe.",
  specialArchiveFilesForbidden:
    "Links und spezielle Dateien sind im Archiv nicht erlaubt.",
  duplicateArchivePaths: "Das Archiv enthält doppelte Pfade.",
  invalidZipArchive: "Das ZIP-Archiv ist ungültig.",
  encryptedArchivesForbidden: "Verschlüsselte Archive sind nicht erlaubt.",
  invalidTarSize: "Das tar-Archiv enthält ungültige Größenangaben.",
  tarTooLarge: "Das tar-Archiv ist zu groß.",
  tarMetadataTooLarge: "Das tar-Archiv enthält zu große Metadaten.",
  invalidPaxData: "Ungültige PAX-Archivdaten.",
  unsupportedPaxData: "Nicht unterstützte PAX-Archivdaten.",
  invalidOrOversizedTar: "Das tar-Archiv ist ungültig oder zu groß.",
  archiveEntryLimit: "Das Archiv enthält zu viele Einträge.",
  unexpectedTarData: "Das tar-Archiv enthält unerwartete zusätzliche Daten.",
  invalidTarChecksum: "Die tar-Archiv-Prüfsumme ist ungültig.",
  incompleteOrOversizedTar: "Das tar-Archiv ist unvollständig oder zu groß.",
  archiveCliNotRegular: "Das Archiv enthält kein reguläres GitHub CLI.",
  incompleteTar: "Das tar-Archiv ist unvollständig.",
  archiveTooLarge: "Das Archiv ist zu groß.",
  archiveCliOrLicenseMissing:
    "Das Archiv enthält kein vollständiges GitHub CLI mit Lizenz.",
  githubCliPlatformUnsupported:
    "GitHub CLI wird hier nur auf macOS und Linux mit ARM64 oder x64 unterstützt.",
  invalidGithubRelease: "Die GitHub-Release-Daten sind ungültig.",
  releasePackageMissing:
    "Das erwartete offizielle GitHub-Release-Paket fehlt oder ist ungültig.",
  releaseChecksumMissing: "Die offizielle Release-Prüfsumme fehlt oder ist mehrdeutig.",
  releaseChecksumMismatch:
    "Die GitHub-Release-Prüfsumme stimmt nicht überein. Es wurde nichts installiert.",
  installationTimeout:
    "Zeitlimit der Installation erreicht. Bitte Netzwerk prüfen und erneut versuchen.",
  installerUnavailable:
    "Der Installer konnte nicht gestartet werden. Bitte Node.js und npm prüfen.",
  installationExitFailure: (code, hint) =>
    `Installation fehlgeschlagen (Exit ${code}${hint ? `, ${hint}` : ""}). Bitte Netzwerk, freien Speicher und Schreibrechte prüfen.`,
  installationDirectoryInvalid: "Der Installationsordner ist kein reguläres Verzeichnis.",
  directInstallPlatformNotice:
    "Direkte Installation wird auf macOS und Linux mit ARM64 oder x64 unterstützt.",
  npmUnavailable:
    "npm wurde nicht gefunden. Bitte Node.js mit npm auf dem Server einrichten.",
  installationInterrupted:
    "Die Installation wurde durch einen Server-Neustart unterbrochen. Bitte erneut versuchen.",
  serviceStopping: "Der Installationsdienst wird beendet.",
  installationAlreadyRunning: "Eine CLI-Installation läuft bereits. Bitte warten.",
  installationDirectoryExists:
    "Ein Installationsordner ist bereits vorhanden. Bitte manuell prüfen; vorhandene Dateien bleiben erhalten.",
  installingPackage: "Offizielles Paket wird installiert …",
  statusSaveFailureSuffix: " Der Status konnte nicht gespeichert werden.",
  downloadingVerifiedRelease:
    "Offizielles GitHub-Release wird geladen und per SHA-256 geprüft …",
  checkingInstalledVersion: "Installation wird mit --version geprüft …",
  installedCliNotExecutable:
    "Die Prüfung ist fehlgeschlagen: Das installierte CLI ist nicht ausführbar.",
  installedVersionCheckFailed:
    "Die Versionsprüfung des installierten CLI ist fehlgeschlagen.",
  installedReleaseVersionMismatch:
    "Die GitHub-CLI-Version stimmt nicht mit dem geprüften Release überein.",
  githubCliInstalled:
    "GitHub CLI installiert und geprüft. Es steht neuen Sitzungen zur Verfügung.",
  cliInstalled: "CLI installiert und geprüft. Du kannst eine Sitzung starten.",
  installationTargetFailed:
    "Installation fehlgeschlagen. Bitte Zielordner und Schreibrechte prüfen.",
  installationAbortedOrTimedOut:
    "Installation wurde abgebrochen oder das Zeitlimit erreicht.",
  installationAborted: "Installation wurde abgebrochen.",
  installationShutdown: "Installation wurde beim Beenden des Servers abgebrochen.",
  cliInstalledElsewhere:
    "Das CLI wurde inzwischen anderweitig installiert. Die bestehende Installation bleibt erhalten.",
  unexpectedGithubRedirect: "Unerwartete GitHub-Download-Weiterleitung.",
  githubRedirectLimit: "Zu viele GitHub-Download-Weiterleitungen.",
  duplicatePaxData: "Doppelte PAX-Archivdaten.",
  alreadyInstalled: "Dieses CLI ist bereits installiert.",
});
