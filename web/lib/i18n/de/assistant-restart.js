export const assistantRestartCopy = {
  title: "Neustart des Agentendienstes ausstehend",
  description:
    "Gespeicherte Änderungen gelten nach dem Neustart des Agentendienstes. Er startet von selbst neu, sobald kein Agent beschäftigt ist.",
  running: "Agentendienst wird neu gestartet …",
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
  restartNowDescription: "Startet sofort neu und unterbricht laufende Agentenarbeit.",
  confirmTitle: "Agentendienst jetzt neu starten?",
  confirmBody:
    "Laufende Agentenarbeit wird unterbrochen, und Agenten sind kurz nicht erreichbar. Eine Kontoanmeldung oder ein laufender Workflow wird noch abgeschlossen.",
};
