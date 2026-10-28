/** Owner-facing copy of agents' email accounts (route problems, tool errors, Telegram). */
export const mail = Object.freeze({
  mailAuthFailed:
    "Der Mailserver hat die Anmeldung abgelehnt. Bitte Benutzername und Passwort prüfen.",
  mailTlsFailed:
    "Die verschlüsselte Verbindung zum Mailserver ist fehlgeschlagen: Das Zertifikat ist ungültig oder der Server bietet kein TLS an.",
  mailUnreachable: "Der Mailserver ist nicht erreichbar. Bitte Host und Port prüfen.",
  mailTimeout: "Der Mailserver hat nicht rechtzeitig geantwortet.",
  mailProtocol: "Der Mailserver hat unerwartet geantwortet.",
  mailPlaintextRefused:
    "Unverschlüsselte Verbindungen sind für diesen E-Mail-Zugang nicht erlaubt.",
  accountNotFound: "E-Mail-Zugang nicht gefunden.",
  invalidAccount:
    "Ungültiger E-Mail-Zugang. Bitte Name, Adresse, Server, Ports und Verschlüsselung prüfen.",
  plaintextNeedsConsent:
    "Eine unverschlüsselte Verbindung braucht die ausdrückliche Erlaubnis am E-Mail-Zugang.",
  passwordUnavailable: "Das gespeicherte E-Mail-Passwort ist nicht verfügbar.",
  invalidPassword:
    "Das Passwort muss 1 bis 1024 Bytes lang sein und darf keine Zeilenumbrüche enthalten.",
  passwordRequiredForServer:
    "Bitte das Passwort erneut eingeben, wenn sich Mailserver, Port oder Verschlüsselung ändern.",
  catalogUnreadable: "Die gespeicherten E-Mail-Zugänge können nicht gelesen werden.",
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
  mailApprovalLimit: "Zu viele E-Mails des Agenten warten bereits auf deine Freigabe.",
  mailSendLimit:
    "Der Agent hat in der letzten Stunde die höchstens erlaubten E-Mails gesendet.",
  mailRevoked: "Der Zugriff des Agenten auf diesen E-Mail-Zugang wurde geändert.",
  mailQueryEmpty: "Eine E-Mail-Suche braucht mindestens ein Kriterium.",
  mailSearchUnsupported:
    "Der Mailserver kann nicht nach Text mit Nicht-ASCII-Zeichen suchen.",
  mailDraftUnsupported:
    "Ein Agent kann nur einen Entwurf mit reinem Text von höchstens 1 MiB senden; HTML-Teile werden nicht gesendet.",
  mailMoveUnsupported:
    "Der Mailserver kann keine Nachrichten verschieben, daher wurde nichts verschoben oder gelöscht.",
  mailAttachmentTooLarge:
    "Die Anhänge sind größer als 25 MB, daher wurde nichts gespeichert oder gesendet.",
  mailDraftChanged:
    "Der Entwurf wurde im Postfach geändert, nachdem er erfasst wurde, daher wurde nichts gesendet. Der Entwurf bleibt erhalten.",
  mailTextUnsupported:
    "Text lässt sich nur aus PDF-, Word-, Excel-, PowerPoint-, Text- und CSV-Anhängen lesen.",
  mailTextFailed:
    "Der Text des Anhangs konnte nicht gelesen werden: Die Datei ist beschädigt, verschlüsselt oder zu komplex.",
  mailSourceRefused: "Der Agent darf diese Datei nicht anhängen oder speichern.",
  mailSourceNotFound: "Die anzuhängende Datei wurde nicht gefunden.",
  mailSourceEmpty: "Die anzuhängende Datei ist leer oder keine normale Datei.",
  mailSaveRefused:
    "Der Agent darf den Anhang dort nicht speichern. Er darf nur unter mail/ in seinem Arbeitsbereich oder in einem Projektordner speichern, in den er schreiben darf.",
  mailApproval: "Dein Agent möchte eine E-Mail senden:",
  mailSend: "Senden",
  mailDecline: "Nicht senden",
  mailOpenToApprove: "Öffne AgentPier, um diese E-Mail zu lesen und freizugeben.",
  mailAgent: (name) => `Agent: ${name}`,
  mailAccount: (name) => `E-Mail-Zugang: ${name}`,
  mailFields: {
    from: "Von",
    to: "An",
    cc: "Cc",
    bcc: "Bcc",
    subject: "Betreff",
    forwardOf: "Weiterleitung von",
    attachment: "Anhang",
    inDraft: "Schon im Entwurf",
    fromOriginal: "Aus der ursprünglichen E-Mail",
    unnamed: "(ohne Namen)",
  },
  mailHtmlKept: "Enthält die HTML-Fassung des Originals, die hier nicht angezeigt wird.",
  mailHtmlOmitted:
    "Die HTML-Fassung des Originals bleibt weg; nur der Text wird weitergeleitet.",
  mailStates: {
    completed: "E-Mail gesendet",
    declined: "E-Mail nicht gesendet — Entwurf bleibt erhalten",
    expired: "Freigabe abgelaufen — Entwurf bleibt erhalten",
    cancelled: "E-Mail abgebrochen; der Zugriff hat sich geändert",
    failed: "Senden fehlgeschlagen; der Entwurf bleibt erhalten",
    unknown:
      "Unklar, ob die E-Mail gesendet wurde; vor erneutem Senden den Ordner Gesendet prüfen",
  },
});
