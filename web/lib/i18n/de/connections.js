export const connectionCopy = {
  title: "Zentrale Provider-Zugänge",
  description:
    "Einen API-Key pro Provider-Zugang speichern und mit kompatiblen CLIs verwenden. CLI, Modell und Startmodus wählst du für jede Sitzung.",
  add: "Provider-Zugang hinzufügen",
  edit: "Provider-Zugang bearbeiten",
  name: "Name des Zugangs",
  key: "API-Key",
  save: "Zugang speichern",
  provider: "API-Anbieter",
  loading: "Anbieter werden geladen …",
  empty: "Noch keine zentralen Provider-Zugänge.",
  native: "Native CLI-Accounts",
  legacy: "Bestehende Anbieterbindung · nur für diese CLI",
  legacyHelp:
    "Diese ältere Anbieterbindung bleibt bearbeitbar. Neue gemeinsame API-Zugänge verwaltest du unter „Zentrale Provider-Zugänge“.",
  providerNames: {
    openrouter: "OpenRouter",
    zai: "Z.ai API",
    "zai-coding-plan": "Z.ai Coding Plan",
    endpoint: "Eigener Endpunkt",
  },
  keySaved: "API-Key gespeichert",
  keyNotRequired: "Kein API-Key nötig",
  keyMissing: "API-Key fehlt",
  keyPlaceholder: "Leer lassen, um den gespeicherten Key zu behalten",
  keyOptional: "Kann auch später ergänzt werden",
  keyHelp:
    "Der Key wird zentral gespeichert. Änderungen gelten für neue Sitzungen; laufende native Prozesse werden nicht beendet.",
  removeKey: "Gespeicherten API-Key entfernen",
  editNamed: (name) => `${name} bearbeiten`,
  deleteNamed: (name) => `${name} löschen`,
  delete: "Zugang löschen",
  deleteConfirm: (name) =>
    `Provider-Zugang „${name}“ und seinen gespeicherten Key löschen? Neue Sitzungen können diesen Zugang dann nicht mehr verwenden. Bestehende Sitzungen und ihre Verläufe bleiben erhalten.`,
  responses: "Responses-API-Zugang bestätigt",
  responsesHelp:
    "Mein Z.ai-Zugang erlaubt die Responses API für Codex. Diese Angabe ist eine eigene Bestätigung und keine automatische Prüfung.",
  compatible: "Kompatible CLIs",
  compatibleRoute: (cli, route) => `${cli} (${route})`,
  noCompatible: "Keine kompatible CLI verfügbar",
  accountDescription:
    "Native Anmeldungen bleiben an ihre jeweilige CLI gebunden. Zentrale API-Zugänge werden getrennt davon verwaltet.",
  cli: "CLI",
  access: "Zugang",
  nativeModel: "Natives Modell (optional)",
  nativeModelHelp:
    "Leer lassen für die CLI-Voreinstellung oder eine exakte native Modell-ID eingeben. Die verfügbare Modellauswahl kannst du auch in der laufenden Sitzung öffnen.",
  nativeDefault: "CLI-Voreinstellung",
  noAccess: "Kein kompatibler Zugang",
  isolated:
    "Dieser Provider-Zugang verwendet ein eigenes CLI-Profil. Anmeldungen, MCP-Konfiguration und Plugins nativer Accounts werden nicht übernommen.",
  legacyLaunch:
    "Diese bestehende Anbieterbindung verwendet ihr gespeichertes Modell. Für eine unabhängige Modellwahl einen zentralen Provider-Zugang verwenden.",
  chooseAccess: "Bitte einen kompatiblen Zugang und ein verfügbares Modell wählen.",
  directoryPlaceholder: "/Pfad/zum/Projekt",
  routes: {
    native: "nativ",
    adapter: (protocol) => `über Adapter · ${protocol}`,
    notOffered: "nicht angeboten",
    shortNames: {
      messages: "Messages",
      responses: "Responses",
      chatCompletions: "Chat Completions",
    },
  },
  endpoint: {
    routing: {
      title: "CLIs und Routen",
      help: "Automatisch nutzt das native Protokoll der CLI, sonst den Protokoll-Adapter (Responses vor Messages vor Chat Completions).",
      select: (cli) => `Route für ${cli}`,
      choices: {
        auto: "Automatisch",
        native: (protocol) => `Nativ (${protocol})`,
        adapter: (protocol) => `Über Adapter (${protocol})`,
        sdk: (protocol) => protocol,
        off: "Aus",
      },
      resolved: (route) => `Verwendet: ${route}`,
      unavailable: (reason) => `Nicht verfügbar: ${reason}`,
      choiceUnavailable: (choice, reason) => `${choice} – nicht verfügbar: ${reason}`,
      reasons: {
        protocolOff: "Protokoll nicht aktiviert",
        anthropicUrlMissing: "Anthropic-kompatible Basis-URL fehlt",
        openaiUrlMissing: "OpenAI-kompatible Basis-URL fehlt",
        other: "Voraussetzung nicht erfüllt",
      },
    },
    adapter: {
      title: "Adapter-Optionen",
      none: "Mit diesen Einstellungen nutzt keine CLI den Protokoll-Adapter.",
      source: (protocol) => `Adapter-Optionen · ${protocol}`,
      reset: "Standard wiederherstellen",
      proposed: "vom Test vorgeschlagen",
      standard: "Standard",
      edited: "von dir geändert",
      resetFor: (protocol) => `Standard wiederherstellen für ${protocol}`,
      applied: "Adapter-Optionen mit den Testvorschlägen aktualisiert.",
      appliedKept:
        "Adapter-Optionen mit den Testvorschlägen aktualisiert. Von dir geänderte Optionen behalten ihren Wert.",
      restored: (protocol) => `Standard für ${protocol} wiederhergestellt.`,
      thinkInactive:
        "Inaktiv: Mit diesen Einstellungen nutzt keine CLI eine Adapter-Route über Chat Completions.",
      capabilities: {
        promptCache: "Prompt-Cache-Breakpoints setzen",
        thinkingBudget:
          "Reasoning als Token-Budget senden (Modelle ohne adaptives Denken)",
        promptCacheKey: "prompt_cache_key senden",
        reasoningEffort: "Reasoning-Stufe senden",
        parallelToolCalls: "parallel_tool_calls weitergeben",
        streamUsage: "Token-Verbrauch im Stream anfordern",
        reasoningReplay: "Reasoning-Text zurücksenden (Denkmodi von DeepSeek, GLM, Kimi)",
        systemMessages: "System-Nachrichten mitten im Verlauf",
        maxTokensField: "Feld für das Ausgabelimit",
      },
      choices: {
        merge: "In die nächste Nutzernachricht einbetten",
        inline: "Als System-Nachrichten belassen",
        max_tokens: "max_tokens",
        max_completion_tokens: "max_completion_tokens",
      },
      think: "<think>-Tags als Reasoning auswerten",
      thinkHelp:
        "Nur für Adapter-Routen über Chat Completions, für Modelle, die ihr Reasoning in den Antworttext schreiben.",
    },
    preset: "Server-Typ",
    presets: {
      ollama: "Ollama",
      llamacpp: "llama.cpp",
      custom: "Benutzerdefiniert (OpenAI/Anthropic-kompatibel)",
    },
    openaiBaseUrl: "OpenAI-kompatible Basis-URL",
    openaiHelp:
      "Endet meist auf /v1. Wird für die Protokolle Responses und Chat Completions verwendet.",
    advanced: "Erweitert",
    anthropicBaseUrl: "Anthropic-kompatible Basis-URL",
    anthropicHelp:
      "Wird für das Protokoll Anthropic Messages verwendet. Leer lassen, wenn der Server keine Anthropic-Messages-API hat.",
    authHeader: "Name des Auth-Headers",
    authHeaderHelp:
      "Leer lassen, um den Key als Authorization: Bearer zu senden. Beispiel: api-key.",
    keyOptional: "Für lokale Server optional",
    keyReentry:
      "Die Adresse hat sich geändert. Gib den API-Key erneut ein oder entferne ihn.",
    test: "Verbindung testen",
    testing: "Teste …",
    testCost:
      "Der Test sendet pro Protokoll ein paar Tokens. Bezahlte Endpunkte können dafür abrechnen.",
    probeModel: "Testmodell",
    probeAuto: "Automatisch",
    probeHint: "Bei Azure OpenAI wähle eines deiner Deployments als Testmodell.",
    protocols: "Protokolle",
    protocolNames: {
      messages: "Anthropic Messages",
      responses: "OpenAI Responses",
      chatCompletions: "OpenAI Chat Completions",
    },
    enables: { messages: "Claude Code", responses: "Codex", chatCompletions: "OpenCode" },
    statuses: {
      ok: "Verfügbar",
      unsupported: "Nicht unterstützt",
      failed: "Fehlgeschlagen",
      skipped: "Nicht getestet",
    },
    reasons: {
      notFound: "Endpunkt nicht gefunden",
      modelNotFound: "Modell auf dem Server nicht gefunden",
      auth: "Anmeldung fehlgeschlagen",
      http: "Unerwartete Serverantwort",
      invalidKey: "Der API-Key enthält Zeichen, die nicht gesendet werden können",
      invalidResponse: "Antwort nicht lesbar",
      timeout: "Zeitüberschreitung",
      network: "Server nicht erreichbar oder Adresse nicht erlaubt",
      tooLarge: "Antwort zu groß",
      aborted: "Abgebrochen",
    },
    warnings: {
      ollamaContextUnknown:
        "Ollama meldet für manche Modelle nicht den geladenen Kontext. Bestätige die Kontextgröße; das Modell-Maximum ist nur ein Hinweis.",
      modelIdSkipped:
        "Einige Modell-IDs waren nicht nutzbar (z. B. Dateipfade). Starte llama.cpp mit --alias oder trage das Modell manuell ein.",
      storedKeyNotUsed:
        "Der gespeicherte Key wurde nicht gesendet, weil sich die Adresse geändert hat.",
      rejectedRequest:
        "Der Server hat die minimale Testanfrage abgelehnt, der Endpunkt existiert aber.",
      modelListTruncated:
        "Eine Verbindung fasst höchstens 200 Modelle. Manuelle Modelle bleiben erhalten; einige erkannte Modelle wurden nicht übernommen.",
    },
    notListed:
      "Die Modellliste konnte nicht gelesen werden. Bisher erkannte und manuelle Modelle bleiben erhalten.",
    models: "Modelle",
    modelId: "Modell-ID",
    context: "Kontext",
    output: "Max. Output",
    source: "Herkunft",
    images: "Bilder",
    imagesFor: (id) => `Bilder ${id}`,
    imageChoices: { auto: "Automatisch", yes: "Ja", no: "Nein" },
    imagesHelp:
      "Nein lässt den Adapter Bild-Eingaben für dieses Modell ablehnen; Codex führt es ohne Bildeingang.",
    sources: { detected: "Erkannt", manual: "Manuell" },
    contextHint: (tokens) => `Modell-Maximum: ${tokens}`,
    contextMissing: "Kontext erforderlich",
    addModel: "Modell hinzufügen",
    removeModel: (id) => `${id} entfernen`,
    azureHint: "Azure OpenAI: Trage deine Deployment-Namen als Modell-IDs ein.",
    noModels: "Noch keine Modelle. Teste die Verbindung oder füge ein Modell hinzu.",
    modelProblems: {
      invalidId:
        "Diese Modell-ID kann nicht verwendet werden. Nutze Buchstaben, Ziffern und . _ : + ~ - ohne Leerzeichen und ohne führenden Schrägstrich.",
      duplicate: "Diese Modell-ID kommt mehrfach vor.",
      contextRange: "Der Kontext muss eine ganze Zahl von 1.024 bis 10.000.000 sein.",
      outputRange:
        "Die maximale Ausgabe muss eine ganze Zahl von 1.024 bis 10.000.000 sein.",
      outputOverContext: "Die maximale Ausgabe darf den Kontext nicht überschreiten.",
    },
    tooManyModels: (max) =>
      `Eine Verbindung enthält höchstens ${max} Modelle. Entferne einige.`,
  },
};
