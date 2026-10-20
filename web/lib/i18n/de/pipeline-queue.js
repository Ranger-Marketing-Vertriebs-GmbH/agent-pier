export const pipelineQueueCopy = {
  tab: "Warteschlange",
  heading: "Warteschlange",
  help: "Einträge starten der Reihe nach, sobald weniger Läufe dieses Projekts aktiv sind als erlaubt.",
  add: "Zur Warteschlange hinzufügen",
  empty:
    "Die Warteschlange ist leer. Füge einen Eintrag hinzu, damit er von selbst startet.",
  loading: "Warteschlange wird geladen …",
  settingsHeading: "Gleichzeitige Läufe",
  settingsHelp:
    "Zählt jeden Lauf dieses Projekts, auch direkt gestartete. Die Warteschlange startet einen Eintrag erst, wenn ein Platz frei ist.",
  limit: "Höchstens gleichzeitig aktiv",
  fewer: "Weniger gleichzeitige Läufe",
  more: "Mehr gleichzeitige Läufe",
  countParked: "Wartende Läufe zählen mit",
  countParkedOn:
    "Ein Lauf, der an einer Freigabe, am Risiko-Gate oder am Token-Budget auf dich wartet, belegt seinen Platz weiter.",
  countParkedOff:
    "Ein Lauf, der auf dich wartet, gibt seinen Platz frei. Ein Lauf, der auf das Ende eines Nutzungslimits wartet, belegt ihn weiter.",
  saveSettings: "Einstellungen speichern",
  discardDraft:
    "Die ungespeicherten Einstellungen der Warteschlange gehen verloren. Trotzdem fortfahren?",
  states: {
    queued: "Wartet",
    starting: "Startet",
    failed: "Start fehlgeschlagen",
    started: "Gestartet",
  },
  runState: (status) => `Lauf: ${status}`,
  runDeleted: "Lauf gelöscht",
  viaMcp: "über MCP",
  baseBranch: (branch) => `Basis ${branch}`,
  budget: (tokens) => `Budget ${tokens} Tokens`,
  moveUp: (title) => `„${title}“ nach oben verschieben`,
  moveDown: (title) => `„${title}“ nach unten verschieben`,
  retry: "Erneut starten",
  deleteItem: (title) => `„${title}“ löschen`,
  deleteTitle: (title) => `Eintrag „${title}“ löschen?`,
  deleteBody: "Der Eintrag startet nicht mehr, und seine Aufgabe geht verloren.",
  removeStarted: (title) =>
    `„${title}“ aus der Warteschlange entfernen; sein Lauf läuft weiter`,
  externalRef: "Externe Referenz (optional)",
  externalRefHelp: "Zum Beispiel ein Ticket-Schlüssel wie AP-123.",
  dialogProject: (name) => `Projekt: ${name}`,
};
