export const talkCopy = Object.freeze({
  start: "Mit dem Agenten sprechen",
  stop: "Sprechen beenden",
  unavailable: "Sprechmodus nicht verfügbar",
  bar: "Sprechmodus",
  phases: {
    starting: "Startet …",
    listening: "Hört zu",
    thinking: "Denkt nach",
    speaking: "Spricht",
    paused: "Pausiert",
  },
  pause: "Sprechen pausieren",
  resume: "Sprechen fortsetzen",
  pausedHint: "Tippen zum Fortsetzen",
  stopButton: "Beenden",
  close: "Schließen",
  setup: "Spracheinstellungen öffnen",
  reasons: {
    agentsOff:
      "Der Sprechmodus nutzt die Sprachdienste der Agenten. Schalte zuerst die Agenten ein.",
    notConfigured:
      "Der Sprechmodus braucht die Spracherkennung. Hinterlege einen Deepgram-Schlüssel unter Zugänge › Dienste für Agenten › Spracherkennung.",
    voiceMissing:
      "Der Sprechmodus braucht eine Stimme, die Antworten vorliest. Hinterlege einen OpenAI- oder ElevenLabs-Schlüssel unter Zugänge › Dienste für Agenten › Spracherkennung.",
    insecure:
      "Der Sprechmodus braucht für das Mikrofon eine sichere Verbindung. Öffne AgentPier über HTTPS, zum Beispiel per Tailscale, oder auf localhost.",
    unsupported:
      "Dieser Browser kann für den Sprechmodus keinen Ton aufnehmen und abspielen.",
    unknown: "Der Sprechmodus ist gerade nicht verfügbar.",
  },
  errors: {
    sendFailed:
      "Die gesprochene Nachricht konnte nicht gesendet werden. Tippe auf die Leiste, um wieder zuzuhören.",
    noReply: "Der Agent ist ohne Antwort zum Vorlesen fertig geworden.",
    rateLimited:
      "Der Sprechmodus wurde in kurzer Zeit zu oft gestartet. Versuche es in ein paar Minuten erneut.",
    notFound: "In diesem Chat ist der Sprechmodus nicht verfügbar.",
    talkEnded: "Der Sprechmodus ist beendet.",
    replaced: "Der Sprechmodus läuft in einem anderen Fenster weiter.",
    connection: "Die Verbindung zu AgentPier wurde unterbrochen.",
    failed: "Der Sprechmodus wurde unerwartet beendet.",
  },
  speak: {
    auth: "Der Stimmenanbieter hat den Schlüssel abgelehnt. Prüfe ihn unter Zugänge › Dienste für Agenten › Spracherkennung.",
    quota: "Das Konto beim Stimmenanbieter hat kein Guthaben mehr.",
    upstreamBusy: "Der Stimmenanbieter ist ausgelastet. Versuche es gleich noch einmal.",
    rejected: "Der Stimmenanbieter hat das Vorlesen dieser Antwort abgelehnt.",
    busy: "Gerade wird schon eine andere Antwort vorgelesen.",
    rateLimited:
      "In kurzer Zeit wurden zu viele Antworten vorgelesen. Versuche es gleich noch einmal.",
    tooLong: "Die Antwort war zu lang zum Vorlesen.",
    decode: "Dieser Browser konnte die Antwort nicht abspielen.",
    failed: "Die Antwort konnte nicht vorgelesen werden.",
  },
  ended: {
    limit: (minutes) => `Der Sprechmodus wurde nach ${minutes} Minuten beendet.`,
    stopped: "Der Sprechmodus ist beendet.",
    hidden: "Der Sprechmodus wurde beendet, weil die Seite ausgeblendet wurde.",
  },
  voice: {
    title: "Stimme für den Sprechmodus",
    description:
      "Liest die Antworten des Agenten im Sprechmodus vor. Der Text jeder Antwort geht an diesen Anbieter; Codeblöcke und lange Links werden nicht vorgelesen.",
    chatgptNote:
      "Eine ChatGPT-Anmeldung kann keinen Text vorlesen: OpenAI-Stimmen brauchen einen OpenAI-API-Schlüssel.",
    provider: "Stimmenanbieter",
    openai: "OpenAI",
    elevenlabs: "ElevenLabs",
    openaiKey: "OpenAI-API-Schlüssel",
    elevenlabsKey: "ElevenLabs-API-Schlüssel",
    keySaved: "Schlüssel gespeichert",
    keyMissing: "Kein Schlüssel eingerichtet",
    removeKey: "Schlüssel beim Speichern entfernen",
    openaiVoice: "Stimme",
    elevenlabsVoice: "Stimmen-ID",
    elevenlabsVoiceHelp: "Die ID einer Stimme aus deiner ElevenLabs-Stimmenbibliothek.",
    save: "Stimmeinstellungen speichern",
  },
});
