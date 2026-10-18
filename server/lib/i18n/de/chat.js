/** Existing German product copy, addressed through English semantic keys. */
export const chat = Object.freeze({
  toolTextUnavailable:
    "Diese Ausgabe ist nicht mehr verfügbar. Lade den Chat neu, um sie erneut zu laden.",
  imageNotFound: "Bild nicht gefunden.",
  imageHistoryMismatch: "Dieses Bild gehört nicht zum aktuellen Chatverlauf.",
  imageNotRegularFile: "Das Bild ist nicht als reguläre Datei verfügbar.",
  imageChangedDuringRead: "Die Bilddatei wurde während des Zugriffs geändert.",
  imageTooLarge: "Die Bilddatei ist größer als 20 MiB.",
  imageChangedOrTooLarge: "Die Bilddatei wurde verändert oder ist zu groß.",
  unsupportedImageFormat:
    "Keine unterstützte Rastergrafik. Erlaubt sind PNG, JPEG, GIF, WebP und AVIF.",
  imageUnreadable: "Die Bilddatei fehlt oder ist nicht lesbar.",
  attachmentInvalidPayload: "Ungültiger Bildanhang.",
  attachmentTooLarge: "Der Bildanhang ist größer als 10 MiB.",
  attachmentUnsupportedFormat:
    "Keine unterstützte Rastergrafik. Erlaubt sind PNG, JPEG, GIF, WebP und AVIF.",
  attachmentLimitReached:
    "Diese Session hat die Höchstzahl gespeicherter Bildanhänge erreicht.",
  attachmentSessionUnavailable:
    "Bildanhänge sind nur in laufenden Sessions mit Bildfreigabe möglich. Bitte die Session neu starten.",
  attachmentWriteFailed: "Der Bildanhang konnte nicht gespeichert werden.",
  linkUnavailable: "Für diese Session ist keine Chat-Verknüpfung verfügbar.",
  historySelectionRequired: "Bitte einen Verlauf dieses Accounts und Projekts auswählen.",
  recentMessageLimit: "Es werden die letzten 500 Nachrichten angezeigt.",
  historyUnavailable: "Für diese Session ist kein Chatverlauf verfügbar.",
  loginInTerminal: "Die Anmeldung erfolgt im Terminal.",
  shellInTerminal: "Shell-Sessions werden im Terminal angezeigt.",
  startNativeConversation:
    "Öffne oder starte eine Unterhaltung im nativen Terminal. Die Chatansicht wird automatisch verbunden.",
  codexBindingPending:
    "Die Chatansicht wartet auf die native Session-ID. Falls Codex neue Hooks zur Prüfung meldet, prüfe sie unter /hooks im Terminal.",
  nativeBindingPending:
    "Die Chatansicht wird automatisch mit dieser nativen Session verbunden.",
  linkedAccountMismatch: "Der verknüpfte Verlauf gehört zu einem anderen Account.",
  savedHistoryNotice: "Gespeicherter Chatverlauf dieser beendeten Session.",
  emptyHistoryNotice:
    "Noch keine Nachrichten vorhanden. Falls eine Anmeldung oder Freigabe aussteht, öffne das Terminal.",
  invalidHistoryId: "Ungültige Verlaufs-ID.",
  historyTooLarge:
    "Dieser Verlauf ist zu groß für die Chatansicht. Bitte das Terminal verwenden.",
  historyOutsideProfile: "Der Verlauf liegt außerhalb des gewählten Profils.",
  codexVersionUnsupported:
    "Codex kann diesen Verlauf mit der installierten Version nicht lesen. Bitte das Terminal verwenden.",
  codexHistoryUnavailable: "Codex-Verlauf ist derzeit nicht erreichbar.",
  serviceStopping: "Der Verlaufsdienst wird beendet.",
  sessionToolMismatch: "Session und Account gehören zu unterschiedlichen Tools.",
  cliUnavailableOnHost: (toolName) =>
    `${toolName} ist auf diesem Rechner nicht installiert.`,
  sessionHistoryPending: "Der Verlauf dieser Session ist noch nicht verfügbar.",
  openCodeHistoryUnavailable:
    "OpenCode kann den Verlauf derzeit nicht lesen. Bitte Installation und CLI-Version prüfen.",
  sessionHistoryBeingWritten: "Der Verlauf dieser Session wird noch geschrieben.",
  sessionHistoryMismatch:
    "Dieser Verlauf gehört nicht zur gewählten Session und ihrem Projekt.",
  historyProjectMismatch: "Dieser Verlauf gehört zu einem anderen Projekt.",
  readOnlyHistoryRequired: "Nur lesende Verlaufsoperationen sind erlaubt.",
  codexDisconnected: "Codex-Verbindung wurde beendet.",
  codexReadTimeout: "Das Lesen des Codex-Verlaufs hat zu lange gedauert.",
});
export const chatAttachmentCopy = {
  invalidSession: "Ungültige Session für den Datei-Upload.",
  unavailable: "In dieser Session können gerade keine Dateien hinzugefügt werden.",
  invalidName: "Ungültiger Dateiname.",
  invalidBody: "Die hochgeladene Datei konnte nicht gelesen werden.",
  tooLarge: "Eine Datei darf höchstens 10 MB groß sein.",
};
