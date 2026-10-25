export const sshCopy = {
  accessesTab: "Zugänge",
  keysTab: "Schlüssel",
  search: "SSH-Einträge durchsuchen",
  searchAccesses: "Name, Host oder Benutzer suchen …",
  searchKeys: "Schlüssel oder Projekt suchen …",
  nameConnection: "Name / Verbindung",
  connection: "Verbindung",
  viewKey: "Schlüssel ansehen",
  closeDetails: "Details schließen",
  noMatches: "Keine passenden Einträge.",
  resetFilters: "Filter zurücksetzen",
  securityNotes: "Hinweise zu Sicherheit und Backups",
  usageUnavailable: "Nutzung noch nicht geladen",
  accessCount: (count) => (count === 1 ? "1 Zugang" : `${count} Zugänge`),

  // Marks a host the session reaches through the sftp_* file tools only.
  sftpBadge: "SFTP",
  type: "Typ",
  typeSsh: "SSH",
  typeSftp: "SFTP",
  signIn: "Anmeldung",
  signInPassword: "Passwort",
  signInKey: "Schlüssel",
  password: "Passwort",
  passwordSaved: "Gespeichert. Gib ein neues Passwort ein, um es zu ersetzen.",
  passwordHint:
    "Das Passwort wird nur lokal gespeichert, die Datei ist nur für den Besitzer lesbar, und es wird nie wieder angezeigt.",
  remoteRoot: "Erlaubter Remote-Ordner",
  remoteRootHint:
    "Optionaler absoluter Pfad, zum Beispiel /srv/files. Agenten können diesen Ordner nicht verlassen.",
  remoteFolder: "Remote-Ordner",
  noRemoteRoot: "Gesamtes Konto",
  legacyAlgorithms: "Alte Algorithmen (ssh-rsa)",
  legacyAlgorithmsHint:
    "Erlaubt RSA-Signaturen mit SHA-1 nur für diesen Host. SHA-1 ist veraltet; nur für alte Geräte einschalten, die nichts anderes akzeptieren.",
  legacyAlgorithmsWarning:
    "Dieser Host akzeptiert veraltete RSA-Signaturen mit SHA-1 (ssh-rsa). Nur für alte Geräte beibehalten, die nichts anderes akzeptieren.",
  interactiveShell: "Interaktive Shell (Netzwerkgeräte)",
  interactiveShellHint:
    "Für Switches und Router, deren CLI die Verbindung bei einem Remote-Befehl schließt. AgentPier öffnet die Konsole, tippt jede Zeile eines Befehls nach der Eingabeaufforderung ein, beantwortet Aufforderungen zum Weiterblättern mit einem Leerzeichen und meldet sich ab. Die Ausgabe hat keinen Exit-Code.",
  legacyOn: "Ein",
  legacyOff: "Aus",
  keyMissing: "Der Schlüssel dieses Hosts wurde gelöscht. Wähle einen anderen Schlüssel.",
  keyDeleted: "Schlüssel gelöscht",
  sftpTestHint:
    "Ein ausdrücklicher Test meldet sich an und öffnet den Remote-Ordner. Auf dem Server wird nichts verändert.",
  sftpDeleteHint:
    "Diesen Host löschen? Ein gespeichertes Passwort wird ebenfalls gelöscht; SSH-Schlüssel bleiben erhalten.",
  toolsReady: "SSH-Tools sind für diese Session bereit.",
  toolsStarting: "Warte auf die Verbindung der CLI mit den SSH-Tools …",
  toolsReload: "Lade diese Unterhaltung neu, um SSH-Tools zu aktivieren.",
  toolsUnavailable: "SSH-Tools sind für diese Session nicht verfügbar.",
  reload: "Neu laden & fortsetzen",
  unsaved: "Speichere deine Host-Auswahl vor dem Neuladen.",
  advanced: "Erweitert · manuelle Verbindungsbefehle",

  keys: "SSH-Schlüssel",
  hosts: "Hosts",
  addKey: "SSH-Schlüssel hinzufügen",
  emptyKeys:
    "Noch keine SSH-Schlüssel vorhanden. Füge vor dem ersten SSH-Zugang einen Schlüssel hinzu.",
  selectKey: "Gespeicherten SSH-Schlüssel auswählen",
  keyFingerprint: "Schlüssel-Fingerabdruck",
  keyDeleteHint: "Diesen gespeicherten SSH-Schlüssel löschen?",
  keyInUse: "Verwendet von",
  keyUnused: "Keinem Host zugewiesen.",
  renameKeyHint:
    "Der Name kann geändert werden. Füge für anderes Schlüsselmaterial einen weiteren Schlüssel hinzu.",

  title: "SSH-Zugänge",
  description: "Verbindungen und Schlüssel für deine Projekte.",
  scope:
    "Zuweisungen helfen beim gezielten Zugriff unter einem Betriebssystembenutzer. Sie isolieren keine Prozesse und schützen Schlüssel nicht vor anderen Prozessen dieses Benutzers.",
  revokeHint:
    "Das Entfernen einer Zuweisung blockiert neue Verbindungen über den Hilfsbefehl. Bestehende SSH-Verbindungen bleiben offen.",
  backupHint: "SSH-Zugänge und Schlüssel sind nicht in Backups enthalten.",
  add: "Zugang hinzufügen",
  edit: "Bearbeiten",
  confirmDelete: "Jetzt löschen",
  deleteHint:
    "Diesen Zugang löschen? Sein SSH-Schlüssel bleibt verfügbar. Bestehende Verbindungen bleiben offen.",
  loading: "SSH-Zugänge werden geladen …",
  empty: "Noch keine SSH-Zugänge vorhanden.",
  name: "Name",
  host: "Host",
  port: "Port",
  username: "Benutzername",
  keyMode: "SSH-Schlüssel",
  generate: "Ed25519-Schlüssel erzeugen",
  import: "Privaten Schlüssel importieren",
  privateKey: "Unverschlüsselter privater SSH-Schlüssel",
  keyHint:
    "Nur unverschlüsselte Schlüssel werden unterstützt. Schlüssel werden lokal mit Dateirechten nur für den Besitzer gespeichert; Passphrasen werden nicht gespeichert.",
  scan: "Hostschlüssel abrufen",
  fingerprint: "Host-Fingerabdruck",
  verifyHint:
    "Vergleiche diesen Fingerabdruck vor der Bestätigung mit einer vertrauenswürdigen, unabhängigen Angabe deines Serverbetreibers.",
  confirmed: "Ich habe den Fingerabdruck unabhängig beim Serverbetreiber geprüft.",
  publicKey: "Öffentlicher Schlüssel",
  publicKeyHint:
    "Trage diesen öffentlichen Schlüssel auf dem Server unter ~/.ssh/authorized_keys des Zielbenutzers ein.",
  copyKey: "Öffentlichen Schlüssel kopieren",
  copyCommand: "Befehl kopieren",
  copied: "Kopiert",
  copyFailed: "Kopieren fehlgeschlagen. Markiere und kopiere den Text manuell.",
  test: "Verbindung testen",
  testHint:
    "Ein ausdrücklicher Test meldet sich an und führt true aus, bei einem Host mit interaktiver Shell wartet er auf die Eingabeaufforderung und meldet sich ab. Nur ein SSH-Fehler lässt ihn scheitern, nicht ein Gerät, das true nicht kennt.",
  testOk: "Verbindung erfolgreich",
  testRejected: "Anmeldung erfolgreich; das Gerät hat den Testbefehl true abgelehnt.",
  busy: "Bitte warten …",
  saved: "Gespeichert",
  sessionSummary: "Wähle die Hosts, die dein Agent in dieser Session nutzen darf.",
  sessionHint:
    "Wähle Zugänge aus und speichere sie. Bereite SSH-Tools ermöglichen deinem Agenten die Nutzung zugewiesener Hosts. Speichern führt keinen Remote-Befehl aus.",
  commandHint:
    "Hänge einen Remote-Befehl an den kopierten Verbindungsbefehl an, zum Beispiel:",
  command: "Verbindungsbefehl",
  launchHint:
    "Weise bei Bedarf SSH-Zugänge zu. Prüfe nach dem Start unter SSH-Zugänge, ob die SSH-Tools bereit sind.",
  manage: "SSH-Zugänge verwalten",
};
