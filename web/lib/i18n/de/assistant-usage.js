// Was ein Agent verbraucht hat (docs/agents.md „Usage“): die
// Gruppe auf seinem Überblick und der Verbrauch eines Chats im Kopf des Chats.
export const assistantUsageCopy = {
  title: "Verbrauch",
  hint: "Die Tokens, die dieser Agent insgesamt verbraucht hat: in seinen Chats, Routinen und Check-ins und über seinen Bot. Kosten stehen dort, wo das Modell einen Preis hat: bei OpenRouter-Modellen und bei Endpunkten, die einen melden. Ein ChatGPT-Konto ist ein Abo ohne Preis pro Token und zeigt deshalb nur Tokens.",
  periods: { today: "Heute", week: "Letzte 7 Tage", month: "Letzte 30 Tage" },
  tokens: (count) => `${count} Tokens`,
  breakdown: (input, output) => `${input} Eingabe · ${output} Ausgabe`,
  cached: (count) => `${count} aus dem Cache`,
  none: "Kein Verbrauch",
  noPrice: "Kein Preis",
  atLeast: (amount) => `mindestens ${amount}`,
  pending: "Wird noch berechnet …",
  unavailable: "Der Verbrauch lässt sich gerade nicht lesen.",
  chart: "Tokens pro Tag in den letzten 30 Tagen",
  chat: {
    title: "Verbrauch dieses Chats",
    button: (tokens) => `Verbrauch dieses Chats: ${tokens} Tokens`,
    cacheRead: "Aus dem Cache gelesen",
    cacheWrite: "In den Cache geschrieben",
    costPartial:
      "Einige Modellaufrufe haben keinen Preis, die Kosten betragen also mindestens diesen Betrag.",
    noPriceHint:
      "Das Modell dieses Chats hat keinen Preis pro Token (ein ChatGPT-Konto oder ein Endpunkt, der keinen meldet), deshalb stehen hier keine Kosten.",
    context: "Kontext beim letzten Modellaufruf",
    contextOf: (used, limit, percent) => `${used} von ${limit} Tokens (${percent} %)`,
    contextUsed: (used) => `${used} Tokens`,
  },
  search: { tokens: "Tokens", cost: "Kosten", chatTokens: "Tokens dieses Chats" },
};
