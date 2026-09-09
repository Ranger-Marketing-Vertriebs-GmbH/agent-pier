export const sshCopy = {
  toolsReady: "SSH-Werkzeuge sind für diese Sitzung bereit.",
  toolsStarting: "Warte auf die Verbindung der CLI mit den SSH-Werkzeugen …",
  toolsReload: "Lade diese Unterhaltung neu, um SSH-Werkzeuge zu aktivieren.",
  toolsUnavailable: "SSH-Werkzeuge sind für diese Sitzung nicht verfügbar.",
  reload: "Neu laden & fortsetzen",
  unsaved: "Speichere deine Host-Auswahl vor dem Neuladen.",
  advanced: "Erweitert · manuelle Verbindungsbefehle",

  keys: "SSH-Schlüssel",
  hosts: "Hosts",
  addKey: "SSH-Schlüssel hinzufügen",
  emptyKeys:
    "Noch keine SSH-Schlüssel vorhanden. Füge vor dem ersten Serverzugang einen Schlüssel hinzu.",
  selectKey: "Gespeicherten SSH-Schlüssel auswählen",
  keyFingerprint: "Schlüssel-Fingerabdruck",
  keyDeleteHint: "Diesen gespeicherten SSH-Schlüssel löschen?",
  keyInUse: "Verwendet von",
  keyUnused: "Keinem Host zugewiesen.",
  renameKeyHint:
    "Der Name kann geändert werden. Füge für anderes Schlüsselmaterial einen weiteren Schlüssel hinzu.",

  title: "Serverzugänge",
  description: "SSH-Schlüssel verwalten und Serverzugänge lokalen Sessions zuweisen.",
  scope:
    "Zuweisungen helfen beim gezielten Zugriff unter einem Betriebssystembenutzer. Sie isolieren keine Prozesse und schützen Schlüssel nicht vor anderen Prozessen dieses Benutzers.",
  revokeHint:
    "Das Entfernen einer Zuweisung blockiert neue Verbindungen über den Hilfsbefehl. Bestehende SSH-Verbindungen bleiben offen.",
  backupHint: "SSH-Zugänge und Schlüssel sind nicht in Backups enthalten.",
  add: "Serverzugang hinzufügen",
  edit: "Bearbeiten",
  remove: "Löschen",
  confirmDelete: "Löschen bestätigen",
  deleteHint:
    "Diesen Zugang löschen? Sein SSH-Schlüssel bleibt verfügbar. Bestehende Verbindungen bleiben offen.",
  save: "Speichern",
  cancel: "Abbrechen",
  close: "Schließen",
  loading: "Serverzugänge werden geladen …",
  retry: "Erneut versuchen",
  empty: "Noch keine Serverzugänge vorhanden.",
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
  testHint: "Ein ausdrücklicher Test verbindet sich mit dem Server und führt true aus.",
  testOk: "Verbindung erfolgreich",
  busy: "Bitte warten …",
  saved: "Gespeichert",
  sessionHint:
    "Wähle Zugänge aus und speichere sie. Bereite SSH-Werkzeuge ermöglichen deinem Agenten die Nutzung zugewiesener Hosts. Speichern führt keinen Remote-Befehl aus.",
  commandHint:
    "Hänge einen Remote-Befehl an den kopierten Verbindungsbefehl an, zum Beispiel:",
  command: "Verbindungsbefehl",
  launchHint:
    "Weise bei Bedarf Serverzugänge zu. Prüfe nach dem Start unter Serverzugänge, ob die SSH-Werkzeuge bereit sind.",
  manage: "Serverzugänge verwalten",
};
