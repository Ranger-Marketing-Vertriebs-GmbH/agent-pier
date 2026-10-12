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
  invalidMcpServerStore: "Die MCP-Server-Datenbank der Sicherung ist ungültig.",
  mcpServerStoreUnusable:
    "Die MCP-Server-Datenbank dieses Hosts hat einen unbekannten Aufbau und kann nicht gesichert werden.",
  invalidMcpServerValues:
    "Die versiegelten Werte der MCP-Server in der Sicherung sind ungültig. Es wurde nichts wiederhergestellt.",
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
  assistantsBusy:
    "Agenten werden gerade aktualisiert oder gewartet. Erstelle das Backup danach erneut.",
  componentLinked: "Ein Backup-Bestandteil enthält einen symbolischen Link.",
  componentLimit: "Ein Backup-Bestandteil überschreitet sein Limit.",
  memberMismatch: "Die Einträge des Archivs passen nicht zu seinem Manifest.",
  insufficientSpace: (required, available) =>
    `Nicht genug freier Speicherplatz: benötigt ${required}, verfügbar ${available}.`,
  profileChanged: (name, tool) =>
    `Profil „${name}“ (${tool}): Eine Datei hat sich während des Backups verändert. Erstelle das Backup erneut.`,
  profileUnreadable: (name, tool) =>
    `Profil „${name}“ (${tool}): Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.`,
  profileCredentialLimit: (name, tool, limit) =>
    `Profil „${name}“ (${tool}): Konfiguration und Zugangsdaten überschreiten ${limit}.`,
  changed: Object.freeze({
    sessions:
      "Sitzungen: Eine Datei hat sich während des Backups verändert. Erstelle das Backup erneut.",
    chat: "Chat-Verläufe: Eine Datei hat sich während des Backups verändert. Erstelle das Backup erneut.",
    agentbus:
      "AgentBus-Verlauf: Eine Datei hat sich während des Backups verändert. Erstelle das Backup erneut.",
    artifacts:
      "Artefakte: Eine Datei hat sich während des Backups verändert. Erstelle das Backup erneut.",
    assistants:
      "Agentendaten: Eine Datei hat sich während des Backups verändert. Erstelle das Backup erneut.",
    providerCredentials:
      "Keys der Provider-Zugänge: Eine Datei hat sich während des Backups verändert. Erstelle das Backup erneut.",
    repositoryCredentials:
      "Repository-Zugangsdaten: Eine Datei hat sich während des Backups verändert. Erstelle das Backup erneut.",
    applicationData:
      "Anwendungsdaten: Eine Datei hat sich während des Backups verändert. Erstelle das Backup erneut.",
  }),
  unreadable: Object.freeze({
    sessions:
      "Sitzungen: Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.",
    chat: "Chat-Verläufe: Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.",
    agentbus:
      "AgentBus-Verlauf: Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.",
    artifacts:
      "Artefakte: Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.",
    assistants:
      "Agentendaten: Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.",
    providerCredentials:
      "Keys der Provider-Zugänge: Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.",
    repositoryCredentials:
      "Repository-Zugangsdaten: Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.",
    applicationData:
      "Anwendungsdaten: Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.",
  }),
  linked: Object.freeze({
    sessions:
      "Sitzungen: Enthält einen symbolischen Link und kann nicht gesichert werden.",
    chat: "Chat-Verläufe: Enthält einen symbolischen Link und kann nicht gesichert werden.",
    agentbus:
      "AgentBus-Verlauf: Enthält einen symbolischen Link und kann nicht gesichert werden.",
    artifacts:
      "Artefakte: Enthält einen symbolischen Link und kann nicht gesichert werden.",
    assistants:
      "Agentendaten: Enthält einen symbolischen Link und kann nicht gesichert werden.",
    providerCredentials:
      "Keys der Provider-Zugänge: Enthält einen symbolischen Link und kann nicht gesichert werden.",
    repositoryCredentials:
      "Repository-Zugangsdaten: Enthält einen symbolischen Link und kann nicht gesichert werden.",
    applicationData:
      "Anwendungsdaten: Enthält einen symbolischen Link und kann nicht gesichert werden.",
  }),
});
