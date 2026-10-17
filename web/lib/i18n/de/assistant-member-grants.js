export const memberGrantCopy = {
  labels: {
    memory: "Gedächtnis (nur lesend)",
    reminders: "Erinnerungen",
    webSearch: "Websuche",
    webFetch: "Webseiten",
    browser: "Browser",
    documents: "Bilder",
    allSkills: "Alle Skills",
    skills: (count) => `Skills: ${count}`,
    shell: (level) => `Shell (${level})`,
    ssh: "SSH",
    someSkills: "Skills",
    anyShell: "Shell",
    mcpServers: (count) => `MCP-Server: ${count}`,
  },
  none: "Keine Werkzeuge",
  gets: (labels) => `Erhält: ${labels}`,
  proposalWarning:
    "Mit einer Warnung markierte Mitglieder erhalten Shell oder SSH, höchstens mit der Stufe und auf den Hosts dieses Agenten. Sie arbeiten unbeaufsichtigt, und Inhalte, die sie lesen, können sie lenken.",
  title: "Vom leitenden Agenten gewährt",
  hint: "Der leitende Agent entscheidet, was dieses auftragsgebundene Mitglied erhält, im Rahmen dessen, was er selbst hat; Shell und SSH brauchen deine Freigabe. Verliert der leitende Agent etwas, verliert es auch das Mitglied.",
  memory: "Gedächtnis (schreibgeschützte Kopie)",
  on: "An",
  off: "Aus",
  history: "Änderungen",
  log: {
    lead: (date, labels) => `${date}: Der leitende Agent hat ${labels} gewährt`,
    revoked: (date, labels) => `${date}: Der leitende Agent hat ${labels} entzogen`,
    ownerRevoked: (date, labels) =>
      `${date}: Das Ausschalten von Shell und SSH für Team-Mitglieder hat ${labels} entzogen`,
    owner: (date, labels) => `${date}: Du hast ${labels} freigegeben`,
  },
  note: {
    reminder: (member) =>
      `${member} hat beim leitenden Agenten eine Erinnerung angelegt; sie steht in dessen Erinnerungen`,
    granted: (member, labels) => `${member} hat vom leitenden Agenten ${labels} erhalten`,
    revoked: (member, labels) => `Der leitende Agent hat ${member} ${labels} entzogen`,
    completed: (member, labels) => `Du hast ${labels} für ${member} freigegeben`,
    declined: (member, labels) => `Du hast ${labels} für ${member} abgelehnt`,
    expired: (member, labels) =>
      `Die Freigabe von ${labels} für ${member} ist abgelaufen`,
    failed: (member, labels) =>
      `${labels} ließ sich ${member} nicht mehr geben; nichts wurde geändert`,
    cancelled: (member, labels) =>
      `Der leitende Agent hat ${labels} für ${member} zurückgezogen`,
  },
  approvalTitle: "Shell oder SSH für ein Team-Mitglied",
  approvalText: (member) => `Der leitende Agent möchte ${member} geben:`,
  approvalWarning:
    "Das Mitglied arbeitet unbeaufsichtigt, und Inhalte, die es liest, können es zur Nutzung dieses Zugriffs verleiten.",
  approve: "Freigabe erteilen",
};
