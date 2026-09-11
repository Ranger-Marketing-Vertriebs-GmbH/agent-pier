export const launchDialogCopy = {
  taskProfile: "Aufgabenprofil",
  noTaskProfile: "Ohne Aufgabenprofil",
  profileUnavailable:
    "Das Aufgabenprofil ist nicht verfügbar. Bitte wähle ein anderes Profil.",
  profileSessionHint:
    "Das Profil belegt die Startoptionen vor. Änderungen gelten nur für diese Sitzung. Ein CLI-Wechsel hebt die Profilauswahl auf.",
  profileMode: (mode) => `Profil · ${mode}`,
  profileModeDescription: (mode) =>
    `Verwendet den Berechtigungsmodus ${mode} aus dem Aufgabenprofil.`,

  nativeModeDescription:
    "Verwendet die Berechtigungen aus deinem Tool-Profil und dessen native Voreinstellungen.",
  codexYoloDescription:
    "YOLO führt Befehle ohne Rückfragen und ohne Sandbox aus. Gilt nur für diese neue Sitzung.",
  claudeAutoDescription:
    "Auto prüft Aktionen mit Claudes Sicherheitsprüfung. Verfügbarkeit hängt von Version, Modell und Kontorichtlinien ab; Rückfragen bleiben möglich.",
  opencodeAutoDescription:
    "Auto bestätigt Berechtigungsanfragen automatisch. Explizite Verbote bleiben aktiv. Gilt nur für diese neue Sitzung.",
  codingSessionDescription: "Ein echtes Terminal. Dein Tool, dein Konto, dein Projekt.",
  shellSessionDescription:
    "Eine lokale Shell für Befehle und Werkzeuge in deinem Arbeitsverzeichnis.",
  sessionNameLabel: "Name der Sitzung",
  sessionNamePlaceholder: "z. B. Website überarbeiten",
  accountLabel: "Konto",
  noAvailableAccounts: "Kein verfügbares Konto",
  nativeModeOption: "Standard · Tool-Voreinstellungen",
  codexYoloOption: "YOLO · ohne Rückfragen und Sandbox",
  claudeAutoOption: "Auto · mit Sicherheitsprüfung",
  opencodeAutoOption: "Auto · Anfragen automatisch bestätigen",
  agentbusLaunchLabel: "AgentBus · Sitzungen im selben Projekt verbinden",
  agentbusLaunchHint:
    "CLIs können einander Nachrichten schicken. Das kann weitere Modellarbeit auslösen.",
};
export const sessionWorkspaceCopy = {
  openNavigation: "Navigation öffnen",
  interruptKeyboardLabel: "Unterbrechen mit Control C",
  sessionTitleDescription: "Konto entfernt",
  terminalTab: "Terminal",
  chatTab: "Chat",
  terminalTopbarDisconnected: "Verbindung getrennt · neuer Versuch …",
  chatNotice: "Terminal wird geladen …",
  keyboardToolbarAriaLabel: "Terminal-Tastatur",
  sessionFooterLabel: "Die Sitzung läuft bei geschlossenem Browser weiter.",
};

export const sessionReloadCopy = {
  retryCurrent: "Mit aktuellem Account erneut versuchen",
  switchTitle: "Mit anderem Account fortsetzen",
  switchHint:
    "Setze dieselbe Unterhaltung mit einem anderen Account derselben CLI fort. Wähle einen bereits angemeldeten Account. Der Verlauf wird kopiert; Zugangsdaten bleiben getrennt. Bei einem Fehler bleibt der ursprüngliche Verlauf erhalten.",
  switchNow: "Account wechseln und fortsetzen",
  targetAccount: "Zielaccount",
  chooseAccount: "Account auswählen …",
  noAccounts:
    "Lege unter Accounts einen weiteren Account für diese CLI an und melde ihn zuerst an.",

  openTerminal: "Terminal öffnen",
  terminalHint:
    "Fragt die CLI nach Hooks oder Projektvertrauen, bestätige dies im Terminal. Das Neuladen läuft beim Schließen dieses Dialogs weiter.",
  submitting: "Anfrage zum Neuladen wird gesendet …",
  prepareFailed:
    "Die Anfrage konnte nicht vorbereitet werden. Verwende einen Browser mit Unterstützung für sichere Verbindungen.",
  title: "Neu laden & fortsetzen",
  hint: "Startet die CLI mit genau dieser Unterhaltung und aktualisierten Integrationen neu. Sitzung, Chatentwurf und zugewiesene Hosts bleiben erhalten.",
  loading: "Fortsetzung dieser Unterhaltung wird geprüft …",
  now: "Jetzt neu laden",
  queue: "Auf Leerlauf warten",
  cancel: "Geplantes Neuladen abbrechen",
  interrupt: "Ich verstehe, dass sofortiges Neuladen die laufende Arbeit unterbricht.",
  uncertain:
    "Die Sitzung arbeitet oder ihre Aktivität ist unklar. Warte auf bestätigten Leerlauf oder bestätige die Unterbrechung.",
  unsupported: "Diese Sitzung kann nicht neu geladen werden.",
  unverified:
    "Die native Unterhaltung ist noch nicht verifiziert. Der laufende Prozess bleibt unverändert.",
  failed:
    "Neuladen fehlgeschlagen. Du kannst es mit derselben Unterhaltung erneut versuchen.",
  requestFailed:
    "Die Anfrage konnte nicht bestätigt werden. Wiederhole dieselbe Anfrage, um das Ergebnis sicher zu prüfen.",
  retry: "Anfrage wiederholen",
  waiting: "Neuladen geplant · warte auf Leerlauf",
  reloading:
    "Warte auf die fortgesetzte Unterhaltung · mögliche Rückfragen im Terminal bestätigen.",
  completed: "Unterhaltung mit aktualisierten Integrationen fortgesetzt.",
  close: "Schließen",
  refresh: "Erneut prüfen",
};
