// Ablehnungen der Laufzeitoptionen eines Agenten (runtimes/runtime-options.js) und der
// Mixture of Agents von Hermes (runtimes/hermes/hermes-options.js).
export const runtimeOptions = Object.freeze({
  optionsInvalid: "Diese Laufzeitoptionen sind ungültig.",
  optionsUnknownRuntime: (runtime) =>
    `Die Laufzeit „${runtime}“ gibt es in diesem AgentPier nicht, also auch keine Optionen dafür.`,
  optionsOtherRuntime: (runtime) =>
    `Dieser Agent läuft nicht auf „${runtime}“, deshalb lassen sich deren Optionen für ihn nicht setzen.`,
  optionsUnknownKey: (key) => `Die Laufzeit des Agenten hat keine Option „${key}“.`,
  mixtureTooMany: (max) => `Mixture of Agents nimmt höchstens ${max} Beratermodelle.`,
  mixtureAdvisorTwice: "Jedes Beratermodell muss ein anderes Modell sein.",
  mixtureAdvisorKind:
    "Nur ein OpenAI-kompatibler Endpunkt oder OpenRouter kann ein Beratermodell sein. ChatGPT-Anmeldungen und andere Protokolle können noch nicht beraten.",
  mixtureAdvisorKeyHeader:
    "Dieser Endpunkt nimmt seinen Schlüssel in einem eigenen Header. Ein Beratermodell braucht einen Endpunkt, der einen Bearer-Schlüssel nimmt.",
  mixtureAdvisorUnavailable:
    "Der Modell-Zugang oder das Modell dieses Beraters ist nicht verfügbar. Prüfe ihn unter Zugänge › Modell-Zugänge.",
  mixtureModelKind:
    "Mixture of Agents braucht das eigene Modell des Agenten auf einem OpenAI-kompatiblen Endpunkt oder OpenRouter mit Bearer-Schlüssel: Es handelt nach den Ratschlägen.",
});
