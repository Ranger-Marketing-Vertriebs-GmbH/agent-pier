/** German browser-visible server messages, addressed through English semantic keys. */
export const backups = Object.freeze({
  archiveExpansionLimit: "Das Entpacklimit des Archivs wurde überschritten.",
  archiveSizeLimit: "Das Größenlimit des Archivs wurde überschritten.",
  invalidArchive: "Ungültiges oder zu großes AgentPier-Archiv.",
  unsupportedFormat: "Nicht unterstütztes Backup-Format oder Schema.",
  invalidMembers: "Ungültige Archiveinträge.",
  invalidMember: "Doppelter, verlinkter oder ungültiger Archiveintrag.",
  invalidEncoding: "Ungültige Archivkodierung.",
  checksumMismatch: "Die Archiv-Prüfsumme stimmt nicht überein.",
  fileDirectoryConflict: "Eine Archivdatei kollidiert mit einem Ordner.",
  passphraseLength:
    "Verschlüsselte Backups benötigen eine Passphrase mit 12 bis 4096 Zeichen.",
  passphraseTooShort:
    "Verschlüsselte Backups benötigen eine Passphrase mit mindestens 12 Zeichen.",
  unsupportedEncryption:
    "Nicht unterstützte Parameter für die Verschlüsselung der Zugangsdaten.",
  passphraseRequired: "Eine Backup-Passphrase ist erforderlich.",
  invalidEnvelope: "Ungültiger Verschlüsselungscontainer für Zugangsdaten.",
  authenticationFailed:
    "Die Backup-Passphrase oder die Prüfung der Zugangsdaten ist fehlgeschlagen.",
  notFound: "Backup nicht gefunden.",
  invalidMemberPath: "Ungültiger Pfad eines Archiveintrags.",
  componentLinked: "Ein Backup-Bestandteil enthält einen symbolischen Link.",
  componentLimit: "Ein Backup-Bestandteil überschreitet sein Limit.",
  importedProjectNotFound: "Das importierte AgentBus-Projekt wurde nicht gefunden.",
  invalidHistoryPage: "Ungültige Seite des importierten Verlaufs.",
  unsupportedSqliteSchema:
    "Nicht unterstützte Schemaversion der eingebetteten SQLite-Datenbank.",
  databaseIntegrity: "Die Integritätsprüfung der Backup-Datenbank ist fehlgeschlagen.",
  invalidProjectMapping: "Ungültige Projektzuordnung.",
  unknownMappedProject: "Die Projektzuordnung verweist auf ein unbekanntes Projekt.",
  projectMappingsCollide: "Projektzuordnungen überschneiden sich.",
  invalidMemoryReferences: "Die wiederhergestellten Memory-Verweise sind ungültig.",
  unexpectedComponent: "Unerwarteter Backup-Bestandteil.",
  invalidManifest: "Ungültiges Backup-Manifest.",
  credentialManifestMismatch: "Das Manifest der Zugangsdaten passt nicht zum Archiv.",
  restoreTargetInvalid:
    "Das Wiederherstellungsziel muss ein absoluter, neuer Ordner sein.",
  restoreTargetLive:
    "Die Wiederherstellung benötigt ein neues Ziel außerhalb des aktiven Datenordners.",
  restoreParentInvalid:
    "Der übergeordnete Ordner des Wiederherstellungsziels muss dem aktuellen Benutzer gehören.",
  restoreTargetExists: "Das Wiederherstellungsziel existiert inzwischen.",
  invalidOptions: "Ungültige Backup-Optionen.",
  invalidOption: "Ungültige Backup-Option.",
  uploadType: "Bitte ein Backup-Archiv als application/octet-stream hochladen.",
});
