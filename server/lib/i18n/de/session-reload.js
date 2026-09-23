/** German browser-visible server messages, addressed through English semantic keys. */
export const sessionReload = Object.freeze({
  conflictingNativeSelection: "Widersprüchliche Auswahl der nativen Unterhaltung.",
  notReloadable: "Diese Sitzung kann nicht neu geladen werden.",
  cliUnavailable: "Das Coding-CLI ist nicht verfügbar.",
  projectDirectoryUnavailable: "Das Projektverzeichnis ist nicht verfügbar.",
  providerAccountLocked:
    "Bitte einen anderen Account für dasselbe CLI wählen. Provider-Sitzungen können den Account nicht wechseln.",
  modelSelectionPending: "Bitte die laufende Modellauswahl vor dem Neuladen abschließen.",
  providerChanged:
    "Der Provider wurde geändert. Bitte vor dem Neuladen den ursprünglichen Provider wiederherstellen.",
  accessModeChanged: "Der Zugriffsmodus des Accounts wurde geändert.",
  conversationAlreadyRunning: "Diese Unterhaltung läuft bereits im Ziel-Account.",
  accountUnavailable: "Der gewählte Account ist nicht mehr verfügbar.",
  conversationChangedBeforeReload:
    "Die native Unterhaltung hat sich vor dem Neuladen geändert. Es wurde kein Prozess beendet.",
  modelChangedBeforeReload:
    "Das Modell hat sich vor dem Neuladen geändert. Es wurde kein Prozess beendet.",
  notIdle: "Die Sitzung ist nicht mehr im Leerlauf. Das Neuladen wurde nicht gestartet.",
  modelNotPreservable:
    "Das aktuelle Modell kann nicht zuverlässig übernommen werden. Bitte vor dem Neuladen ein exaktes natives Modell bestätigen.",
  shuttingDown: "Das Neuladen von Sitzungen wird beendet.",
  invalidRequest: "Ungültige Anfrage zum Neuladen der Sitzung.",
  requestLimit:
    "Für diese Sitzung wurde die Höchstzahl an Anfragen zum Neuladen erreicht.",
  pending: "Ein Neuladen dieser Sitzung steht bereits aus.",
  noVerifiedConversation:
    "Für das Neuladen ist keine bestätigte native Unterhaltung verfügbar.",
  confirmInterruption:
    "Bitte die Unterbrechung bestätigen, bevor diese Sitzung neu geladen wird.",
  resumedCliExited: "Das fortgesetzte CLI wurde beendet.",
  resumedCliDifferentConversation:
    "Das fortgesetzte CLI hat eine andere Unterhaltung gewählt.",
  conversationChangedWhileWaiting:
    "Die native Unterhaltung hat sich während des Wartens geändert.",
  alreadyRestarting: "Die Sitzung wird bereits neu gestartet.",
  intentMissing: "Die Angabe zum Neuladen fehlt.",
});
