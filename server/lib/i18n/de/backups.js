/** German browser-visible server messages, addressed through English semantic keys. */
export const backups = Object.freeze({
  downloadRateLimited:
    "Zu viele Backup-Downloads. Bitte in einer Minute erneut versuchen.",
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
  caseConflict:
    "Zwei Archiveinträge unterscheiden sich nur in Groß- und Kleinschreibung oder Unicode-Normalisierung und kollidieren auf diesem Dateisystem.",
  uploadLengthRequired: "Für den Upload wird die Größe des Archivs benötigt.",
  uploadLengthMismatch: "Der Upload hat nicht die angekündigte Größe.",
  invalidUploadChunk: "Ungültiger Abschnitt des Uploads.",
  uploadBusy: "Dieser Upload nimmt gerade einen anderen Abschnitt an.",
  uploadOffsetMismatch:
    "Der Abschnitt passt nicht an das Ende des bisherigen Uploads. Der Upload wird an der richtigen Stelle fortgesetzt.",
  uploadIncomplete: "Der Upload ist noch nicht vollständig.",
  historyAuthenticationFailed:
    "Ein verschlüsselter Verlauf der Sicherung ist beschädigt oder wurde verändert. Es wurde nichts wiederhergestellt.",
  unsupportedHistorySeal:
    "Die verschlüsselten Verläufe dieser Sicherung stammen von einer neueren AgentPier-Version. Aktualisiere AgentPier, um sie wiederherzustellen. Es wurde nichts wiederhergestellt.",
  memberMismatch: "Die Einträge des Archivs passen nicht zu seinem Manifest.",
  insufficientSpace: (required, available) =>
    `Nicht genug freier Speicherplatz: benötigt ${required}, verfügbar ${available}.`,
  profileUnreadable: (name, tool) =>
    `Profil „${name}“ (${tool}): Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.`,
  profileCredentialLimit: (name, tool, limit) =>
    `Profil „${name}“ (${tool}): Konfiguration und Zugangsdaten überschreiten ${limit}.`,
  unreadable: Object.freeze({
    sessions:
      "Sessions: Eine Datei ist keine reguläre, eigene Datei und kann nicht gesichert werden.",
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
      "Sessions: Enthält einen symbolischen Link und kann nicht gesichert werden.",
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
