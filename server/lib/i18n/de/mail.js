/** Owner-facing copy of agents' email accounts (route problems and tool errors). */
export const mail = Object.freeze({
  mailAuthFailed:
    "Der Mailserver hat die Anmeldung abgelehnt. Bitte Benutzername und Passwort prüfen.",
  mailTlsFailed:
    "Die verschlüsselte Verbindung zum Mailserver ist fehlgeschlagen: Das Zertifikat ist ungültig oder der Server bietet kein TLS an.",
  mailUnreachable: "Der Mailserver ist nicht erreichbar. Bitte Host und Port prüfen.",
  mailTimeout: "Der Mailserver hat nicht rechtzeitig geantwortet.",
  mailProtocol: "Der Mailserver hat unerwartet geantwortet.",
  mailPlaintextRefused:
    "Unverschlüsselte Verbindungen sind für dieses Konto nicht erlaubt.",
  accountNotFound: "E-Mail-Konto nicht gefunden.",
  invalidAccount:
    "Ungültiges E-Mail-Konto. Bitte Name, Adresse, Server, Ports und Verschlüsselung prüfen.",
  plaintextNeedsConsent:
    "Eine unverschlüsselte Verbindung braucht die ausdrückliche Erlaubnis am Konto.",
  passwordUnavailable: "Das gespeicherte E-Mail-Passwort ist nicht verfügbar.",
  invalidPassword:
    "Das Passwort muss 1 bis 1024 Bytes lang sein und darf keine Zeilenumbrüche enthalten.",
  passwordRequiredForServer:
    "Bitte das Passwort erneut eingeben, wenn sich Mailserver, Port oder Verschlüsselung ändern.",
  catalogUnreadable: "Die gespeicherten E-Mail-Kontodaten können nicht gelesen werden.",
  testRateLimited:
    "Zu viele Verbindungstests für E-Mail-Zugänge. Bitte in einer Minute erneut versuchen.",
});
