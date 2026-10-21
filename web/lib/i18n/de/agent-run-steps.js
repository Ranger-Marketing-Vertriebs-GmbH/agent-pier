// Was die laufende Antwort eines Agenten gerade tut (AGENTPIER-184): seine Live-Schritte,
// eine Antwort, die nichts vom Modell hört, und ein sehr langer Chat.
export const agentRunStepsCopy = {
  steps: "Schritte",
  stepCount: (count) => (count === 1 ? "1 Schritt" : `${count} Schritte`),
  earlier: (count) => (count === 1 ? "1 früherer Schritt" : `${count} frühere Schritte`),
  phase: {
    model: "Wartet auf das Modell",
    thinking: "Denkt nach",
    writing: "Schreibt die Antwort",
    tool: "Führt ein Tool aus",
    approval: "Wartet auf Freigabe",
    compacting: "Fasst den Chat zusammen",
  },
  retrying: (attempt, of) =>
    of
      ? `Das Modell hat nicht geantwortet, neuer Versuch (${attempt} von ${of})`
      : "Das Modell hat nicht geantwortet, neuer Versuch",
  thinking: "Hat nachgedacht",
  tools: {
    exec: "Befehl",
    process: "Hintergrundbefehl",
    image_generate: "Erstellt ein Bild",
    web_fetch: "Liest eine Webseite",
    web_search: "Sucht im Web",
    browser: "Nutzt den Browser",
    read: "Liest eine Datei",
    write: "Schreibt eine Datei",
    edit: "Bearbeitet eine Datei",
    apply_patch: "Bearbeitet Dateien",
    pdf: "Liest ein PDF",
    memory_search: "Durchsucht das Gedächtnis",
    memory_get: "Liest das Gedächtnis",
  },
  tool: (name) => `Tool ${name}`,
  state: {
    running: "Läuft",
    done: "Erledigt",
    failed: "Fehlgeschlagen",
  },
  stalled: (minutes) =>
    minutes === 1
      ? "Seit 1 Minute keine Antwort vom Modell."
      : `Seit ${minutes} Minuten keine Antwort vom Modell.`,
  stalledHint:
    "Das Modell hängt vielleicht. Stoppe die Antwort oder versuche es erneut: Der Agent macht dort weiter, wo er aufgehört hat.",
  continueMessage: "Bitte mach dort weiter, wo du aufgehört hast.",
  timedOut:
    "Das Modell hat nicht rechtzeitig geantwortet. Prüfe, was der Agent schon erledigt hat, bevor du es erneut versuchst.",
  longChat:
    "Dieser Chat ist sehr lang, deshalb werden Antworten langsamer und teurer. Starte für ein neues Thema einen neuen Chat.",
};
