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
  runtimeApplies: (only, name) =>
    `Einstellungen ohne „Nur ${only}“ gelten auch für ${name}-Agenten.`,
  runtimeRestart: (name) => `Startet ${name}-Agenten neu`,
  runtimeRestartLabel: (name) =>
    `${name}-Agenten starten neu, um eine Änderung zu übernehmen`,
  runtimeUnqualified: (product, version, name) =>
    `${product} ${version} ist für diese Einstellungen nicht freigegeben. ${name}-Agenten starten mit den Standards von ${name}, bis die freigegebene Version läuft.`,
  runtimeOnly: (name) => `Nur ${name}`,
  runtimeOnlyLabel: (name, other) =>
    `Gilt nur für ${name}-Agenten; ${other}-Agenten behalten den Standard von ${other}`,
  loading: "Einstellungen werden geladen …",
  loadFailed: "Die erweiterten Einstellungen konnten nicht geladen werden.",
  save: "Einstellungen speichern",
  groups: {
    runs: "Aufträge",
    media: "Bilder und Medien",
  },
  live: "Sofort",
  restart: "Neustart nötig",
  nextTurn: "Nächste Nachricht",
  liveLabel: "Wird sofort wirksam",
  restartLabel: "Wird nach einem Neustart des Agentendienstes wirksam",
  on: "An",
  off: "Aus",
  emptyText: "leer",
  unavailable: "Mit der installierten Agentenlaufzeit nicht verfügbar",
  defaultValue: (value) => `Standard: ${value}`,
  defaultOption: (value) => `Standard (${value})`,
  reset: "Standard",
  resetLabel: (label) => `${label} auf den Standard zurücksetzen`,
  outOfRange: (label, min, max) =>
    `${label}: Erlaubt sind ganze Zahlen von ${min} bis ${max}.`,
  ownRange: (label, min, max) => `${label}: Erlaubt sind Werte von ${min} bis ${max}.`,
  invalidValue: (label) => `${label}: Dieser Wert ist nicht erlaubt.`,
  settings: {
    runTimeout: {
      label: "Zeitlimit pro Auftrag",
      help: "Wie lange ein Agent höchstens an einer Nachricht arbeiten darf, bevor der Lauf abgebrochen wird. Angabe in Sekunden, von 300 (5 Minuten) bis 604800 (7 Tage).",
      fallbackNote: "48 Stunden",
      unit: "Sekunden",
    },
    thinkingDefault: {
      label: "Denkstufe",
      help: "Wie gründlich Modelle mit Denkmodus standardmäßig nachdenken. Höhere Stufen antworten sorgfältiger, brauchen aber länger und verbrauchen mehr Token. Kennt ein Modell eine Stufe nicht, nutzt es die nächstpassende. Hermes-Agenten kennen keine Stufe „Adaptiv“ und behalten damit den Standard von Hermes.",
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
      options: {
        auto: "Automatisch",
        efficient: "Sparsam",
        balanced: "Ausgewogen",
        high: "Hoch",
      },
    },
    imageMaxDimension: {
      label: "Maximale Bildgröße",
      help: "Auf welche längste Seite Bilder in Unterhaltungen und Tool-Ergebnissen verkleinert werden, von 256 bis 2000 Pixel. Kleinere Werte sparen Token; größere Bilder lehnen Modellanbieter ab, sobald eine Unterhaltung viele davon enthält.",
      unit: "Pixel",
    },
    mediaRetention: {
      label: "Aufbewahrung von Mediendateien",
      help: "Ohne Angabe räumt die Agentenlaufzeit nur ausgehende Zwischendateien auf. Mit einem Wert löscht sie alle gespeicherten Mediendateien, die älter sind, auch empfangene Bilder und Sprachnachrichten, etwa aus Telegram. Erlaubt sind 48 bis 168 Stunden. Dateianhänge in den Arbeitsbereichen der Agenten sind nicht betroffen.",
      fallback: "keine allgemeine Bereinigung (nur ausgehende Zwischendateien)",
      unit: "Stunden",
    },
  },
};
