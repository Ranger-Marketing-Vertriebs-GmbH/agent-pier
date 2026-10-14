export const assistantAdvancedCopy = {
  title: "Erweitert",
  entry: "Erweiterte Einstellungen",
  entrySub: "Feineinstellungen der Agentenlaufzeit für alle Agenten",
  intro:
    "Diese Einstellungen gelten für alle Agenten. AgentPier gibt hier nur Einstellungen frei, die keine Sicherheits-, Zugangs- oder Verwaltungsfunktion berühren.",
  stopped:
    "Der Agentendienst läuft gerade nicht. Gespeicherte Änderungen gelten beim nächsten Start.",
  unqualified: (version) =>
    `Die installierte Agentenlaufzeit ${version} ist für diese Einstellungen nicht freigegeben. Gespeicherte Werte bleiben erhalten und gelten wieder, sobald die freigegebene Version läuft.`,
  loading: "Einstellungen werden geladen …",
  loadFailed: "Die erweiterten Einstellungen konnten nicht geladen werden.",
  save: "Einstellungen speichern",
  groups: {
    runs: "Aufträge",
    media: "Bilder und Medien",
  },
  live: "Sofort",
  restart: "Neustart nötig",
  liveLabel: "Wird sofort wirksam",
  restartLabel: "Wird nach einem Neustart des Agentendienstes wirksam",
  unavailable: "Mit der installierten Agentenlaufzeit nicht verfügbar",
  defaultValue: (value) => `Standard: ${value}`,
  defaultOption: (value) => `Standard (${value})`,
  reset: "Standard",
  resetLabel: (label) => `${label} auf den Standard zurücksetzen`,
  outOfRange: (label, min, max) =>
    `${label}: Erlaubt sind ganze Zahlen von ${min} bis ${max}.`,
  settings: {
    runTimeout: {
      label: "Zeitlimit pro Auftrag",
      help: "Wie lange ein Agent höchstens an einer Nachricht arbeiten darf, bevor der Lauf abgebrochen wird. Angabe in Sekunden, von 60 Sekunden bis 7 Tage.",
      fallback: "48 Stunden",
      unit: "Sekunden",
    },
    thinkingDefault: {
      label: "Denkstufe",
      help: "Wie gründlich Modelle mit Denkmodus standardmäßig nachdenken. Höhere Stufen antworten sorgfältiger, brauchen aber länger und verbrauchen mehr Token. Kennt ein Modell eine Stufe nicht, nutzt es die nächstpassende.",
      fallback: "abhängig vom Modell",
      options: {
        off: "Aus",
        minimal: "Minimal",
        low: "Niedrig",
        medium: "Mittel",
        high: "Hoch",
        xhigh: "Sehr hoch",
        adaptive: "Adaptiv",
        max: "Maximal",
        ultra: "Ultra",
      },
    },
    userTimezone: {
      label: "Zeitzone",
      help: "In welcher Zeitzone Agenten Zeitangaben in Nachrichten und Ereignissen lesen und nennen. Ohne Angabe gilt die Zeitzone dieses Rechners.",
      fallback: "Zeitzone dieses Rechners",
    },
    imageQuality: {
      label: "Bildqualität",
      help: "Wie stark Bilder für das Modell verkleinert werden. „Sparsam“ spart Token, „Hoch“ erhält mehr Details bei Bildschirmfotos und Dokumenten.",
      fallback: "Automatisch",
      options: {
        auto: "Automatisch",
        efficient: "Sparsam",
        balanced: "Ausgewogen",
        high: "Hoch",
      },
    },
    imageMaxDimension: {
      label: "Maximale Bildgröße",
      help: "Auf welche längste Seite Bilder in Unterhaltungen und Werkzeugergebnissen verkleinert werden, von 256 bis 8192 Pixel. Kleinere Werte sparen Token.",
      fallback: "1200 Pixel",
      unit: "Pixel",
    },
    mediaRetention: {
      label: "Aufbewahrung von Mediendateien",
      help: "Nach wie vielen Stunden die Agentenlaufzeit ihre zwischengespeicherten Mediendateien löscht, etwa empfangene Bilder und Audiodateien (1 bis 168 Stunden). Ohne Angabe räumt sie nach ihrer eigenen Vorgabe auf. Dateianhänge in den Arbeitsbereichen der Agenten sind nicht betroffen.",
      fallback: "Vorgabe der Agentenlaufzeit",
      unit: "Stunden",
    },
  },
};
