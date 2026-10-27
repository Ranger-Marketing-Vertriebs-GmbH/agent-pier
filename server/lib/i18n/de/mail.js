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
  mailAccountUnavailable:
    "Diesen E-Mail-Zugang gibt es nicht mehr. Lade die Seite neu und wähle erneut.",
  telegramSendersMail:
    "Ein Agent mit eigenem Telegram-Bot für andere Personen darf keinen E-Mail-Zugang haben. Entferne den E-Mail-Zugang oder trenne zuerst den Bot.",
  mailNotGranted: "Der Agent hat keinen Zugriff auf diesen E-Mail-Zugang.",
  mailSendNotGranted:
    "Der Agent darf diesen E-Mail-Zugang nur lesen, nicht daraus senden.",
  mailOriginRefused:
    "E-Mail ist nur in deinen eigenen Anfragen, Routinen und Hooks mit Häkchen bei E-Mail verfügbar.",
  mailNotFound: "Die Nachricht oder der Ordner wurde nicht gefunden.",
  mailNoTrash: "Dieses Postfach hat keinen Papierkorb, daher wurde nichts gelöscht.",
  mailNoArchive:
    "Dieses Postfach hat keinen Archivordner, daher wurde nichts verschoben.",
  mailNoDrafts:
    "Dieses Postfach hat keinen Entwürfe-Ordner, daher wurde kein Entwurf gespeichert.",
  mailAttachmentsUnsupported: "Einen Entwurf mit Anhängen kann ein Agent nicht senden.",
  mailApprovalLimit: "Zu viele E-Mails des Agenten warten bereits auf deine Freigabe.",
  mailSendLimit:
    "Der Agent hat in der letzten Stunde die höchstens erlaubten E-Mails gesendet.",
  mailRevoked: "Der Zugriff des Agenten auf diesen E-Mail-Zugang wurde geändert.",
  mailQueryEmpty: "Eine E-Mail-Suche braucht mindestens ein Kriterium.",
});
