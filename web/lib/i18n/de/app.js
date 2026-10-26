export const appCopy = {
  appAriaLabel: "Navigation schließen",
  pageDescription: "Dieser Link ist nicht verfügbar.",
  returnToOverview: "Zur Übersicht",
  workspaceLoading: "Workspace wird geladen …",
};
export const appDialogsCopy = {
  keychainRetention:
    " Vom CLI verwaltete Schlüsselbund-Einträge können erhalten bleiben.",
  titleStop: "Session stoppen?",
  titleRemove: "Session entfernen?",
  titleRemoveTool: (name) => `${name} entfernen?`,
  confirmCopyRemoveTool: (name) =>
    `${name} wird von diesem Rechner gelöscht. Agenten nutzen danach einen anderen installierten Browser, sobald der Agentendienst neu startet. Solange die Agenten ihn nutzen, beende zuerst den Agentendienst.`,
  titleDeleteAccount: "Account löschen?",
  buttonLogin: "Anmeldeterminal öffnen",
  renamedSessionLabel: "Neuer Name",
  confirmCopyStop: (value1) =>
    `„${value1}“ und der darin laufende Prozess werden beendet. Das bisherige Terminal bleibt lesbar.`,
  confirmCopyRemove: (value1) =>
    `„${value1}“ und die gespeicherte Terminalausgabe sowie nicht angepinnte Artifacts werden endgültig entfernt. Angepinnte Artifacts bleiben erhalten.`,
  confirmCopyDeleteAccount: (value1, value2) =>
    `Das Profil „${value1}“ und seine lokalen Dateien werden gelöscht.${value2}`,
  confirmCopyLogin: (value1) =>
    `Die native Anmeldung für „${value1}“ öffnet sich in einer eigenen Session. Folge dort den Anweisungen deines Tools.`,
};
export const mobileHeaderCopy = {
  iconButtonAriaLabel: "Navigation öffnen",
  mobileBrand: "AgentPier",
};
export const sidebarCopy = {
  newLabel: "Neu",
  newSessionItem: "Session",
  newAgentItem: "Agent",
  brandAriaLabel: "AgentPier Startseite",
  brandLabel: "AgentPier",
  localBadge: "LOKAL",
  ariaLabel: "Hauptnavigation",
  collapseSidebar: "Navigation einklappen",
  expandSidebar: "Navigation ausklappen",
  projectsNavigation: "Projekte",
  sidebarEmptyDescription: "Platz für deine nächste Idee.",
  sidebarEmptyLabel: "Deine Sessions erscheinen hier.",
  hostStatusLabel: "Lokaler Workspace",
  serviceConnecting: "Verbindung wird hergestellt",
  localHostDescription: "Auf deinem Rechner",
  remoteLink: "Remote öffnen",
  menu: "Menü",
  closeMenu: "Menü schließen",
  search: "Suchen (⌘K)",
  searchRow: "Suchen",
  workGroup: "Arbeiten",
  setupGroup: "Einrichten",
  manageAgents: "Alle Agenten verwalten",
  clisAndExtensions: "CLIs und Erweiterungen",
  hints: {
    decisions: (count) => (count === 1 ? "1 Entscheidung" : `${count} Entscheidungen`),
    failed: (count) => `${count} fehlgeschlagen`,
    running: (count) => `${count} läuft`,
    agentsOff: "aus",
    agentsStopped: "Dienst gestoppt",
    agentsUpdate: "Update bereit",
    cliUpdates: (count) => (count === 1 ? "1 Update" : `${count} Updates`),
    problems: (count) => (count === 1 ? "1 Problem" : `${count} Probleme`),
    appUpdate: "Update verfügbar",
  },
};
export const sidebarGroupCopy = {
  activeTerminalLabel: "Terminal aktiv",
  labelsUnknown: "Aktivität unbekannt",
};
export const useWorkspaceNavigationCopy = {
  pageNotFound: "Seite nicht gefunden",
  sessionNotFound: "Session nicht gefunden",
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
  updateTitle: "Eine neue Version ist verfügbar",
  updateDescription:
    "AgentPier wurde aktualisiert. Lade neu, um mit der neuen Version weiterzuarbeiten.",
};
export const updateNoticeCopy = {
  message: "Neue Version verfügbar",
  reload: "Neu laden",
  dismiss: "Ausblenden",
};
