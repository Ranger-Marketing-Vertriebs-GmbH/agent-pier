export const requestCopy = {
  reloadRequired:
    "Diese Claude-Sitzung braucht ein einmaliges Update für Fragen im Chat. Führe /reload-plugins im Terminal aus. Deine Unterhaltung bleibt geöffnet.",
  legacyQuestion:
    "Claude hat eine Frage gestellt, aber diese Sitzung hat ihre Auswahlmöglichkeiten nicht in den Chat übertragen. Beantworte sie im Terminal und führe danach /reload-plugins aus.",
  hookTrustTitle: "Codex-Hooks prüfen",
  hookTrustDescription:
    "Codex wartet auf die Hook-Freigabe. Vertrauenswürdige Hooks können außerhalb der Sandbox laufen. Dein Chat-Entwurf bleibt bis zu deiner Entscheidung erhalten.",
  hookTrustAllow: "Hooks vertrauen und fortfahren",
  hookTrustSkip: "Ohne Vertrauen fortfahren",
  folderTrustTitle: "Claude-Arbeitsordner vertrauen",
  folderTrustDescription:
    "Claude wartet auf die Freigabe zum Lesen, Bearbeiten und Ausführen von Dateien in diesem Arbeitsordner. Dein Chat-Entwurf bleibt bis zu deiner Entscheidung erhalten.",
  folderTrustAllow: "Ordner vertrauen und fortfahren",
  folderTrustExit: "Sitzung beenden",
  startup: {
    theme: {
      title: "Claude-Textstil wählen",
      description:
        "Claude fragt beim ersten Start nach dem Textstil für das Terminal. Die Wahl lässt sich später mit /theme ändern. Dein Chat-Entwurf bleibt bis zu deiner Entscheidung erhalten.",
    },
    apiKey: {
      title: "API-Key für Claude bestätigen",
      description:
        "Claude hat den API-Key dieses Kontos in der Umgebung erkannt und fragt, ob er verwendet werden soll.",
    },
    securityNotes: {
      title: "Sicherheitshinweise von Claude",
      description:
        "Claude zeigt beim ersten Start Sicherheitshinweise an. Du bist für Claudes Aktionen verantwortlich und solltest sie prüfen, besonders beim Ausführen von Code.",
    },
    login: {
      title: "Claude-Anmeldung erforderlich",
      description:
        "Dieses Konto ist noch nicht angemeldet. Die Anmeldung braucht einen Browser-Code und wird im Terminal abgeschlossen.",
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
  unknown: "Zustellung unklar. Im Terminal prüfen.",
  responding: "Antwort wird zugestellt …",
  required: "Bitte jede Frage vollständig beantworten.",
  other: "Andere Antwort",
  otherLabel: (prompt) => `Andere Antwort: ${prompt}`,
  details: "Angefragte Aktion",
  cwd: "Arbeitsverzeichnis",
  scopes: {
    turn: "Für diesen Turn",
    once: "Einmal",
    session: "Diese Sitzung",
    persistent: "Dauerhaft",
  },
  loading: "Native Rückfragen werden geladen …",
};
