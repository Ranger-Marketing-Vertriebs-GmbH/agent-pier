export const dictationCopy = Object.freeze({
  start: "Diktat starten",
  stop: "Diktat beenden",
  unavailable: "Spracheingabe nicht verfügbar",
  connecting: "Mikrofon wird verbunden …",
  recording: "Aufnahme läuft. Jetzt sprechen.",
  finishing: "Transkript wird abgeschlossen …",
  stopped: "Diktat beendet. Der Text steht im Nachrichtenfeld.",
  setup: "Spracherkennung einrichten",
  close: "Hinweis schließen",
  reasons: {
    agentsOff:
      "Die Spracheingabe nutzt die Spracherkennung der Agenten. Schalte die Agenten ein und hinterlege unter Accounts › Dienste für Agenten › Spracherkennung einen Deepgram-Schlüssel.",
    notConfigured: "Für die Spracheingabe fehlt ein Deepgram-Schlüssel.",
    insecure:
      "Der Mikrofonzugriff braucht eine sichere Verbindung. Öffne AgentPier über HTTPS, zum Beispiel per Tailscale, oder auf localhost.",
    unsupported: "Dieser Browser kann für das Diktat keinen Ton aufnehmen.",
    unknown: "Die Spracheingabe ist gerade nicht verfügbar.",
  },
  errors: {
    denied:
      "Der Mikrofonzugriff wurde verweigert. Erlaube ihn im Browser, um zu diktieren.",
    noMicrophone: "Es wurde kein Mikrofon gefunden.",
    rateLimited:
      "Zu viele Diktate in kurzer Zeit. Versuche es in ein paar Minuten erneut.",
    busy: "Gerade laufen zu viele Diktate. Versuche es gleich noch einmal.",
    auth: "Deepgram hat den Schlüssel abgelehnt. Prüfe ihn unter Accounts › Dienste für Agenten › Spracherkennung.",
    quota: "Das Deepgram-Konto hat kein Guthaben mehr.",
    upstreamBusy: "Deepgram ist ausgelastet. Versuche es gleich noch einmal.",
    rejected: "Deepgram hat den Audiostream abgelehnt.",
    invalid: "Der Audiostream war ungültig.",
    slow: "Die Verbindung zu Deepgram ist zu langsam. Versuche es erneut.",
    failed: "Die Spracheingabe wurde unerwartet beendet.",
    connection: "Die Verbindung zu AgentPier wurde unterbrochen.",
  },
  ended: {
    limit: (minutes) => `Das Diktat wurde nach ${minutes} Minuten beendet.`,
    idle: "Das Diktat wurde beendet, weil kein Ton ankam.",
    replaced: "Das Diktat läuft in einem anderen Fenster weiter.",
    closed: "AgentPier startet neu, deshalb wurde das Diktat beendet.",
  },
});
