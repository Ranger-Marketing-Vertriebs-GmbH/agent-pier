// Was ein leitender Agent von seinem eigenen Zugriff mit seinen dauerhaften
// Mitgliedern teilt, wie der Besitzer es sieht und widerruft (Server lead-shares.js).
export const leadShareCopy = {
  title: "Vom leitenden Agenten geteilt",
  hint: "Der leitende Agent teilt seinen eigenen Zugriff mit diesem dauerhaften Mitglied: Projektordner, Coding-Projekte, MCP-Server und Bilder lesen. Das gilt nur, solange er ihn selbst hat, in seinen Aufgaben und in deinen eigenen Chats mit diesem Mitglied. Coding-Aufträge brauchen weiter deine Freigabe, und Dateien ändern sich nur in Aufgaben, die Dateien ändern dürfen.",
  empty: "Der leitende Agent teilt nichts mit diesem Mitglied.",
  loading: "Freigaben werden geladen …",
  folder: { read: "Ordner: lesen", write: "Ordner: lesen und ändern" },
  coding: "Coding",
  mcpServer: (name) => `MCP-Server ${name}`,
  capability: { documents: "Bilder lesen" },
  unknownProject: "Projekt nicht mehr lesbar",
  unknownServer: "Server nicht mehr lesbar",
  forTask: "Für eine Aufgabe",
  standing: "Dauerhaft",
  via: (lead) => `über ${lead}`,
  inactive: "Gerade ohne Wirkung: Der leitende Agent hat es zurzeit nicht",
  revoke: "Widerrufen",
  revokeLabel: (what, member) => `${what} für ${member} widerrufen`,
  confirmTitle: (what, member) => `${what} für ${member} widerrufen?`,
  confirmBody: (lead) =>
    `Das Mitglied verliert diesen Zugriff sofort; wartende Coding-Aufträge darauf schlagen fehl. ${lead} kann ihn erneut teilen.`,
  confirmLabel: "Jetzt widerrufen",
  projectSection: "Von leitenden Agenten geteilt",
  projectHint:
    "Mitglieder, die dieses Projekt über ihren leitenden Agenten nutzen. Das gilt nur, solange der leitende Agent es selbst hat.",
  serverShared: "Über einen leitenden Agenten genutzt",
  taskMember: "Auftragsgebundenes Mitglied",
  taskHint:
    "Was der leitende Agent diesem auftragsgebundenen Mitglied von seinem eigenen Zugriff gewährt hat. Das gilt nur, solange er ihn selbst hat. Widerrufen beendet eine Gewährung sofort, so wie wenn der leitende Agent sie zurücknimmt.",
  shell: (level) => `Shell: ${level}`,
  ssh: "SSH auf den Hosts des leitenden Agenten",
  sshShort: "SSH",
  codingViaLead: "Coding-Aufträge über den leitenden Agenten",
  codingFixed:
    "Gehört zur Aufgabe: Jeder Auftrag wartet auf deine Freigabe. Zum Beenden stoppe oder archiviere das Mitglied.",
  taskConfirmBody: (lead) =>
    `Das Mitglied verliert diesen Zugriff sofort; wartende Freigaben dafür werden abgebrochen. ${lead} kann ihn erneut gewähren.`,
};

// Ein Tippen des Besitzers, nachdem ein leitender Agent beim Verarbeiten eines
// Mitgliederergebnisses etwas nicht ändern durfte (Server conversations.js goAheadMarks).
export const goAheadCopy = {
  button: "Direkt umsetzen",
  message: "Ja, direkt umsetzen",
  hint: "Beim Verarbeiten eines Mitgliederergebnisses durfte der leitende Agent etwas nicht tun, das nur auf deine eigene Nachricht hin geht, etwa einen SSH-Befehl. Tippe, um ihm dein Okay zu geben.",
};
