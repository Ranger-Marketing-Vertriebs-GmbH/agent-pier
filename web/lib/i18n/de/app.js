export const appCopy = {
  appAriaLabel: "Navigation schließen",
  pageDescription: "Dieser Link ist nicht verfügbar.",
  returnToOverview: "Zur Übersicht",
  workspaceLoading: "Workspace wird geladen …",
  agentBusLoading: "AgentBus wird geladen …",
};
export const appDialogsCopy = {
  keychainRetention:
    " Vom CLI verwaltete Schlüsselbund-Einträge können erhalten bleiben.",
  titleStop: "Sitzung stoppen?",
  titleRemove: "Sitzung entfernen?",
  titleDeleteAccount: "Konto löschen?",
  buttonLogin: "Anmeldeterminal öffnen",
  renamedSessionLabel: "Neuer Name",
  confirmCopyStop: (value1) =>
    `„${value1}“ und der darin laufende Prozess werden beendet. Das bisherige Terminal bleibt lesbar.`,
  confirmCopyRemove: (value1) =>
    `„${value1}“ und die gespeicherte Terminalausgabe werden endgültig entfernt.`,
  confirmCopyDeleteAccount: (value1, value2) =>
    `Das Profil „${value1}“ und seine lokalen Dateien werden gelöscht.${value2}`,
  confirmCopyLogin: (value1) =>
    `Die native Anmeldung für „${value1}“ öffnet sich in einer eigenen Sitzung. Folge dort den Anweisungen deines Tools.`,
};
export const mobileHeaderCopy = {
  iconButtonAriaLabel: "Navigation öffnen",
  mobileBrand: "AgentPier",
};
export const sidebarCopy = {
  brandAriaLabel: "AgentPier Startseite",
  brandLabel: "AgentPier",
  localBadge: "LOCAL",
  ariaLabel: "Hauptnavigation",
  repositoriesNavigation: "Repositories",
  extensionsNavigation: "MCP & Skills",
  pluginsNavigation: "Plugins & Marketplace",
  agentBusNavigation: "AgentBus",
  sidebarEmptyDescription: "Platz für deine nächste Idee.",
  sidebarEmptyLabel: "Deine Sitzungen erscheinen hier.",
  hostStatusLabel: "Lokaler Workspace",
  serviceConnecting: "Verbindung wird hergestellt",
  localHostDescription: "Auf deinem Rechner",
  remoteLink: "Remote öffnen",
  sidebarCaption: "DEIN RECHNER. DEINE TOOLS.",
};
export const sidebarGroupCopy = {
  activeTerminalLabel: "Terminal aktiv",
  labelsUnknown: "Aktivität unbekannt",
};
export const useWorkspaceNavigationCopy = {
  pageNotFound: "Seite nicht gefunden",
  sessionNotFound: "Sitzung nicht gefunden",
  profileNotFound: "Profil nicht gefunden",
};
export const useWorkspaceStateCopy = {
  serviceConnectionError: (value1) =>
    `Verbindung zum lokalen Dienst fehlgeschlagen: ${value1}`,
};
export const appRecoveryCopy = {
  title: "Ansicht nicht verfügbar",
  description: "Die App konnte diese Ansicht nicht laden. Bitte lade sie erneut.",
  reload: "Ansicht neu laden",
};
