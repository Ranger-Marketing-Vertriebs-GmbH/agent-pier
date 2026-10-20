export const requestCopy = {
  reloadRequired:
    "Diese Claude-Session braucht ein einmaliges Update für Fragen im Chat. Führe /reload-plugins im Terminal aus. Deine Unterhaltung bleibt geöffnet.",
  legacyQuestion:
    "Claude hat eine Frage gestellt, aber diese Session hat ihre Auswahlmöglichkeiten nicht in den Chat übertragen. Beantworte sie im Terminal und führe danach /reload-plugins aus.",
  hookTrustTitle: "Codex-Hooks prüfen",
  hookTrustDescription:
    "Codex wartet auf die Hook-Freigabe. Vertrauenswürdige Hooks können außerhalb der Sandbox laufen. Dein Chat-Entwurf bleibt bis zu deiner Entscheidung erhalten.",
  hookTrustAllow: "Hooks vertrauen und fortfahren",
  hookTrustSkip: "Ohne Vertrauen fortfahren",
  folderTrustTitle: "Claude-Arbeitsordner vertrauen",
  folderTrustDescription:
    "Claude wartet auf die Freigabe zum Lesen, Bearbeiten und Ausführen von Dateien in diesem Arbeitsordner. Dein Chat-Entwurf bleibt bis zu deiner Entscheidung erhalten.",
  folderTrustAllow: "Ordner vertrauen und fortfahren",
  folderTrustExit: "Session beenden",
  startup: {
    theme: {
      title: "Claude-Textstil wählen",
      description:
        "Claude fragt beim ersten Start nach dem Textstil für das Terminal. Die Wahl lässt sich später mit /theme ändern. Dein Chat-Entwurf bleibt bis zu deiner Entscheidung erhalten.",
    },
    apiKey: {
      title: "API-Key für Claude bestätigen",
      description:
        "Claude hat den API-Key dieses Accounts in der Umgebung erkannt und fragt, ob er verwendet werden soll.",
    },
    securityNotes: {
      title: "Sicherheitshinweise von Claude",
      description:
        "Claude zeigt beim ersten Start Sicherheitshinweise an. Du bist für Claudes Aktionen verantwortlich und solltest sie prüfen, besonders beim Ausführen von Code.",
    },
    login: {
      title: "Claude-Anmeldung erforderlich",
      description:
        "Dieser Account ist noch nicht angemeldet. Die Anmeldung braucht einen Browser-Code und wird im Terminal abgeschlossen.",
    },
    autoModeDefault: {
      title: "Auto-Modus als Standard festlegen?",
      description:
        "Claude fragt, ob der Auto-Modus der Standard-Berechtigungsmodus dieses Accounts werden soll. Im Auto-Modus prüft Claude jeden Tool-Aufruf auf riskante Aktionen, führt die als weniger riskant eingeschätzten aus und blockiert den Rest. Dein Chat-Entwurf bleibt bis zu deiner Entscheidung erhalten.",
    },
    autoModeBilling: {
      title: "Abrechnungshinweis zum Claude-Auto-Modus",
      description:
        "Claude meldet, dass die Klassifizierer-Anfragen des Auto-Modus in dieser Session weiter wie bisher abgerechnet werden. Fortfahren lässt den Auto-Modus weiterlaufen; Abbrechen unterbricht die wartende Aktion. Dein Chat-Entwurf bleibt bis zu deiner Entscheidung erhalten.",
    },
    unknown: {
      title: "Claude wartet auf eine Eingabe",
      description:
        "Claude zeigt beim Start ein Auswahlmenü, das der Chat nicht kennt. Bitte im Terminal fortfahren; der Chat sendet solange nichts.",
    },
  },
  startupOptions: {
    apiKey: { yes: "API-Key verwenden", no: "Nicht verwenden (empfohlen)" },
    securityNotes: { continue: "Weiter" },
    autoModeDefault: {
      accept: "Auto-Modus als Standard festlegen",
      decline: "Aktuellen Modus behalten",
    },
    autoModeBilling: { continue: "Im Auto-Modus fortfahren", cancel: "Aktion abbrechen" },
  },
  title: "Native Rückfragen",
  permission: "Freigabe erforderlich",
  question: "Antwort erforderlich",
  progress: (current, total) => `Frage ${current} von ${total}`,
  next: "Nächste Frage",
  previous: "Vorherige Frage",
  answer: "Antwort senden",
  handoff: "Im Terminal beantworten",
  terminal: "Terminal öffnen",
  terminalApproval: "Freigabe ins Terminal verschoben.",
  dismissNotice: "Ausblenden",
  unknown: "Zustellung unklar. Im Terminal prüfen.",
  responding: "Antwort wird zugestellt …",
  required: "Bitte jede Frage vollständig beantworten.",
  other: "Andere Antwort",
  otherLabel: (prompt) => `Andere Antwort: ${prompt}`,
  decline: "Ablehnen",
  declineConfirm: "Ablehnen bestätigen",
  note: "Notiz für Claude (optional)",
  noteLabel: (prompt) => `Notiz für Claude: ${prompt}`,
  preview: (label) => `Vorschau: ${label}`,
  details: "Angefragte Aktion",
  claudeOptions: {
    allow: "Einmal erlauben",
    always: "Dauerhaft erlauben",
    deny: "Ablehnen",
  },
  alwaysRules:
    "Dauerhaft erlauben speichert diese Regeln für diesen Claude-Account, in allen Projekten:",
  planTitle: "Plan zur Freigabe",
  plan: "Vorgeschlagener Plan",
  planHint: "Weiter planen hält Claude an, damit du im Chat Feedback geben kannst.",
  planOptions: {
    acceptEdits: "Annehmen, Änderungen automatisch erlauben",
    approve: "Annehmen, Änderungen einzeln freigeben",
    keep: "Weiter planen",
  },
  cwd: "Arbeitsverzeichnis",
  scopes: {
    turn: "Für diesen Turn",
    once: "Einmal",
    session: "Diese Session",
    persistent: "Dauerhaft",
  },
  loading: "Native Rückfragen werden geladen …",
};
