// Label-Regeln im Tickets-Tab eines Projekts: die Regelliste, ihre Zustände und Fehler
// und die Herkunftszeile eines Tickets, das eine Regel in die Warteschlange gestellt hat.
export const ticketRulesCopy = {
  title: "Label-Regeln",
  add: "Label-Regel hinzufügen",
  pause: "Pausieren",
  resume: "Fortsetzen",
  rowActions: (label) => `Aktionen für Label-Regel ${label}`,
  deleteTitle: (label) => `Label-Regel „${label}“ löschen?`,
  deleteBody:
    "Die Regel übernimmt keine Tickets mehr. Schon übernommene Tickets bleiben in der Warteschlange und werden nie erneut übernommen, auch nicht von einer neuen Regel mit diesem Label.",
  empty:
    "Noch keine Label-Regeln. Eine Regel stellt jedes offene Ticket mit ihrem Label einmal in die Warteschlange.",
  picked: (count) =>
    count === 1 ? "1 Ticket übernommen" : `${count} Tickets übernommen`,
  paused: "Pausiert",
  active: "Aktiv",
  failing: "Fehler",
  loadFailed: "Die Label-Regeln konnten nicht geladen werden.",
  fromRule: (label) => `Aus der Label-Regel „${label}“`,
  fromDeletedRule: "Aus einer gelöschten Label-Regel",
  capped: {
    github:
      "Nur die neuesten 300 offenen Issues werden geprüft; ältere Issues mit diesem Label werden nicht übernommen.",
    plane:
      "Nur 500 Work Items, geschlossene eingeschlossen, werden geprüft; Tickets mit diesem Label dahinter werden nicht übernommen.",
  },
  errors: {
    labelGone: "Das Label gibt es in der Ticketquelle nicht.",
    queueFull:
      "Die Warteschlange ist voll. Weitere Tickets werden übernommen, sobald Platz ist.",
    notConnected:
      "Die Ticketquelle oder GitHub ist für dieses Projekt nicht mehr verbunden.",
    projectGone: "Das Projekt gibt es nicht mehr.",
  },
};

// Der Dialog, der eine Label-Regel hinzufügt oder bearbeitet.
export const labelRuleDialogCopy = {
  titleNew: "Label-Regel hinzufügen",
  titleEdit: "Label-Regel bearbeiten",
  source: "Quelle",
  label: "Label",
  labelHint:
    "Genauer Label-Name; offene Tickets, die es schon tragen, werden auch übernommen.",
  intro:
    "Jedes Ticket, das die Regel übernimmt, kommt in die Warteschlange und läuft mit diesen Einstellungen.",
  paused: "Pausiert",
  pausedHint: "Eine pausierte Regel übernimmt keine Tickets, bis du sie fortsetzt.",
  save: "Regel speichern",
};
