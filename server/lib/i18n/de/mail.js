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
});
