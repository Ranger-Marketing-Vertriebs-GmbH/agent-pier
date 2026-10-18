export const projectAgentsCopy = {
  tab: "Agenten",
  title: "Agentenzugriff",
  hint: "Derselbe Zugriff wie im Tab „Arbeit“ des jeweiligen Agenten: Eine Änderung hier gilt auch dort.",
  agentsLabel: "Agenten mit Zugriff auf dieses Projekt",
  coding: "Darf in diesem Projekt Coding-Sessions starten",
  codingHint:
    "Projektwissen und Coding-Aufträge mit den Pipelines, die im Tab „Arbeit“ des Agenten freigegeben sind. Ordnerzugriff setzt das voraus.",
  folderLegend: "Ordnerzugriff",
  folder: { none: "Keiner", read: "Lesen", write: "Lesen und schreiben" },
  noAgents: "Noch keine dauerhaften Agenten. Lege einen unter Agenten an.",
  members: "Team-Mitglieder mit Zugriff",
  membersHint:
    "Auftragsgebundene Mitglieder nutzen den Ordner über ihren leitenden Agenten, höchstens auf dessen Stufe. Das entscheidet der leitende Agent in seinem Team.",
  memberVia: (lead, level) => `über ${lead} · ${level}`,
  unknownLead: "seinen leitenden Agenten",
  reloaded:
    "Der Zugriff dieses Agenten wurde inzwischen an anderer Stelle geändert. Der aktuelle Stand wird angezeigt; wähle erneut.",
  unregistered:
    "Agentenzugriff gehört zu einem registrierten Projektordner. Füge den Ordner hinzu, um Agenten zuzuweisen.",
  saving: "Wird gespeichert …",
  pick: "Agentenzugriff (optional)",
  pickHint:
    "Erlaube Agenten, dieses Projekt sofort zu nutzen. Du kannst das später im Tab „Agenten“ des Projekts ändern.",
  pickNone: "Kein Zugriff",
  pickCoding: "Nur Coding",
  pickRead: "Coding und Ordner lesen",
  pickWrite: "Coding, Ordner lesen und schreiben",
  pickFailed: (count) =>
    count === 1
      ? "Das Projekt wurde hinzugefügt, aber der Zugriff für 1 Agenten ließ sich nicht setzen. Setze ihn im Tab „Agenten“ des Projekts."
      : `Das Projekt wurde hinzugefügt, aber der Zugriff für ${count} Agenten ließ sich nicht setzen. Setze ihn im Tab „Agenten“ des Projekts.`,
  done: "Fertig",
};
