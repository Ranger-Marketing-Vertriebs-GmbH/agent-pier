export const assistantRestartCopy = {
  title: "Neustart des Agentendienstes ausstehend",
  description:
    "Gespeicherte Änderungen gelten nach dem Neustart des Agentendienstes. Er startet von selbst neu, sobald kein Agent beschäftigt ist.",
  running: "Agentendienst wird neu gestartet …",
  failed:
    "Der letzte Neustartversuch ist fehlgeschlagen. Er wird gleich erneut versucht.",
  reasons: (labels) => `Nötig für: ${labels}.`,
  reason: {
    webTools: "Web-Tools der Agenten",
    webSearch: "Websuche",
    pdfModel: "PDF-Lesen",
    connection: "einen Provider-Zugang",
    telegram: "einen Telegram-Bot",
  },
  waiting: (labels) => `Wartet auf: ${labels}.`,
  waitingFor: {
    ASSISTANT_WORK: "arbeitende Agenten",
    TEAM_WORK: "Teamarbeit",
    CHANNEL_WORK: "Telegram-Nachrichten",
    ACCOUNT_LOGIN: "eine Kontoanmeldung",
    WORKFLOW_WORK: "laufende Workflows",
    SCHEDULED_WORK: "geplante Läufe",
    active: "andere Wartung",
    unavailable: "den Agentendienst",
  },
  restartNow: "Jetzt neu starten",
  restartNowDescription:
    "Startet sofort neu und unterbricht alle laufende Agentenarbeit.",
  affected: (names, members = 0) =>
    `Unterbrochen: ${names || "keine Agenten"}${members ? ` (+${members} Teammitglied${members === 1 ? "" : "er"})` : ""}`,
  confirmTitle: "Agentendienst jetzt neu starten?",
  confirmBody:
    "Alle laufende Agentenarbeit wird unterbrochen, und Agenten sind nicht erreichbar, bis der Dienst wieder läuft. Das kann etwa eine Minute oder länger dauern. Eine Kontoanmeldung oder ein laufender Workflow wird noch abgeschlossen.",
};
