export const assistantSemanticMemoryCopy = {
  title: "Semantische Gedächtnissuche",
  label: "Notizen nach Bedeutung finden",
  description: (size) =>
    `Die Gedächtnissuche vergleicht normalerweise Wörter. Ist dies an, finden OpenClaw-Agenten Notizen auch nach ihrer Bedeutung, über Formulierungen und Sprachen hinweg: Ein lokales Embedding-Modell (EmbeddingGemma 300M) läuft auf diesem Computer, und kein Gedächtnisinhalt verlässt ihn. Nötig sind ein einmaliger Download von ${size} und ebenso viel Speicherplatz sowie etwa 550 bis 750 MB Arbeitsspeicher, während Agenten suchen; er wird nach zehn Minuten ohne Suche wieder frei. Hermes-Agenten laden ihr Gedächtnis in jeden Chat und haben keine Gedächtnissuche.`,
  states: {
    off: "Aus",
    on: "An",
    downloading: "Download läuft",
    rebuilding: "Neuaufbau läuft",
    failed: "Aus",
  },
  turnOn: "Einschalten …",
  turnOnHint:
    "Lädt das Modell herunter, startet den Agentendienst neu und baut die Indizes neu auf.",
  turnOff: "Ausschalten …",
  turnOffHint: "Startet den Agentendienst neu und kehrt zur Stichwortsuche zurück.",
  running: "Läuft",
  downloading: (received, total) =>
    `Embedding-Modell wird heruntergeladen: ${received} von ${total}`,
  phases: {
    stopping: "Agentendienst wird angehalten",
    starting: "Agentendienst wird gestartet",
  },
  indexing: (done, total) =>
    total
      ? `Gedächtnisindizes werden neu aufgebaut: ${done} von ${total} Agenten`
      : "Gedächtnisindizes werden neu aufgebaut",
  pending:
    "An. Die Gedächtnisindizes werden neu aufgebaut, sobald der Agentendienst startet.",
  onTitle: "Semantische Gedächtnissuche einschalten?",
  onBody: (size) =>
    `AgentPier lädt das Embedding-Modell (${size}) von Hugging Face herunter, startet dann den Agentendienst neu und baut den Gedächtnisindex jedes Agenten neu auf. Laufende Agentenarbeit wird unterbrochen, und die Agenten sind erst wieder erreichbar, wenn der Neuaufbau fertig ist. Bei wenigen Notizen dauert das Sekunden, bei einem großen Gedächtnis länger.`,
  onBodyFailure:
    "Schlägt der Download oder der Neuaufbau fehl, wird die Stichwortsuche wiederhergestellt, und dies bleibt aus.",
  terms:
    "Das Modell ist EmbeddingGemma von Google. Mit dem Einschalten akzeptierst du die",
  termsLink: "Gemma-Nutzungsbedingungen",
  onConfirm: "Herunterladen und einschalten",
  offTitle: "Semantische Gedächtnissuche ausschalten?",
  offBody:
    "Der Agentendienst startet neu und baut den Gedächtnisindex jedes Agenten für die Stichwortsuche neu auf. Laufende Agentenarbeit wird unterbrochen, und die Agenten sind erst wieder erreichbar, wenn der Neuaufbau fertig ist.",
  offBodyModel: "Das heruntergeladene Modell wird entfernt.",
  offConfirm: "Ausschalten",
  unavailable: {
    EMBEDDING_PLATFORM_UNSUPPORTED:
      "Auf diesem Computer nicht verfügbar: Für seine Plattform gibt es keinen llama.cpp-Build.",
    RUNTIME_UPDATE_REQUIRED:
      "Benötigt die aktuelle OpenClaw-Laufzeit. Aktiviere zuerst das Update unter OpenClaw-Updates.",
    SERVICE_STOPPED: "Starte zuerst den Agentendienst.",
  },
  failures: {
    INTERRUPTED:
      "AgentPier wurde während der Einrichtung neu gestartet. Die Gedächtnissuche arbeitet mit Stichwörtern. Schalte sie erneut ein, um es noch einmal zu versuchen.",
    SERVICE_BUSY:
      "Der Agentendienst konnte gerade nicht neu starten: Ein Update, eine Anmeldung oder eine Agentenaktion läuft. Nichts wurde geändert. Versuche es später erneut.",
    EMBEDDING_DOWNLOAD_FAILED:
      "Der Download ist fehlgeschlagen. Prüfe die Internetverbindung und schalte erneut ein; der Download wird dort fortgesetzt, wo er abbrach.",
    EMBEDDING_DOWNLOAD_STALLED:
      "Der Download ist stehen geblieben. Prüfe die Internetverbindung und schalte erneut ein; der Download wird dort fortgesetzt, wo er abbrach.",
    EMBEDDING_CHECKSUM_MISMATCH:
      "Die heruntergeladene Datei hatte nicht die erwartete Prüfsumme und wurde verworfen. Schalte erneut ein, um sie noch einmal zu laden.",
    EMBEDDING_DISK_SPACE: "Für das Embedding-Modell ist nicht genug Speicherplatz frei.",
    EMBEDDING_SERVER_UNUSABLE:
      "Der llama.cpp-Server startet auf diesem Computer nicht. Unter Linux braucht er glibc 2.34 oder neuer (2.38 auf arm64), OpenMP und OpenSSL 3 (Debian und Ubuntu: libgomp1 und libssl3).",
    EMBEDDING_MODEL_MISSING:
      "Das Embedding-Modell ist nicht mehr auf diesem Computer, daher wurde die Stichwortsuche wiederhergestellt. Schalte erneut ein, um es herunterzuladen.",
    EMBEDDING_SERVER_MISSING:
      "Der llama.cpp-Server ist nicht mehr auf diesem Computer, daher wurde die Stichwortsuche wiederhergestellt. Schalte erneut ein, um ihn zu installieren.",
    RUNTIME_UPDATE_REQUIRED:
      "Die verwendete OpenClaw-Laufzeit hat keine lokalen Embeddings, daher wurde die Stichwortsuche wiederhergestellt. Aktiviere die aktuelle Laufzeit und schalte dann erneut ein.",
    MEMORY_INDEX_FAILED:
      "Die Gedächtnisindizes konnten mit dem Embedding-Modell nicht neu aufgebaut werden. Die Stichwortsuche wurde wiederhergestellt.",
    MEMORY_INDEX_UNVERIFIED:
      "Das Embedding-Modell hat auf diesem Computer nicht funktioniert, daher konnten die Gedächtnisindizes damit nicht aufgebaut werden. Die Stichwortsuche wurde wiederhergestellt.",
    MEMORY_INDEX_TIMEOUT:
      "Der Neuaufbau der Gedächtnisindizes dauerte zu lange und wurde abgebrochen. Die Stichwortsuche wurde wiederhergestellt.",
  },
  failed: (code) =>
    `Das Umschalten ist nicht gelungen (${code}). Die Gedächtnissuche arbeitet mit Stichwörtern.`,
  errors: {
    SEMANTIC_MEMORY_CONFLICT:
      "Dies wurde inzwischen geändert. Der aktuelle Stand wird angezeigt.",
    SEMANTIC_MEMORY_OPERATION_RUNNING: "Ein Umschalten läuft bereits.",
  },
  agentHint:
    "Die semantische Gedächtnissuche ist an: Die Suche und der Agent finden Notizen auch nach ihrer Bedeutung.",
};
