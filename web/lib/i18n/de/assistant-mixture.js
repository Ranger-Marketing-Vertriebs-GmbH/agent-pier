// Mixture of Agents eines Hermes-Agenten (Tab Fähigkeiten, ADR 0007 Schritt 7a): seine
// Beratermodelle, die eigene Oberfläche der Laufzeit (web/features/assistants/runtimes/hermes/).
export const assistantMixtureCopy = {
  title: "Mixture of Agents",
  subtitle: "Beratermodelle",
  hint: "Hermes fragt bis zu drei Beratermodelle einmal pro Nachricht und gibt ihre Antworten dem eigenen Modell des Agenten, das dann allein handelt.",
  description:
    "Vor jeder deiner Nachrichten bekommt jeder Berater den Text des Chats (nicht die Tools oder Anweisungen des Agenten) und antwortet einmal. Ihre Anbieter erhalten also deine Unterhaltung, und jeder Berater kostet einen Modellaufruf mehr pro Nachricht. Das eigene Modell des Agenten handelt weiter und trägt den Durchlauf. Auch die Routinen dieses Agenten nutzen die Berater. Kann der Anbieter eines Beraters eine Anfrage nicht bedienen (keine Antwort binnen zwei Minuten, ein Ratenlimit, aufgebrauchtes Guthaben, ein Verbindungsfehler), antwortet Hermes stattdessen mit dem eigenen Modell des Agenten.",
  off: "Aus: Das eigene Modell des Agenten arbeitet allein.",
  advisor: (number) => `Berater ${number}`,
  chooseConnection: "Zugang wählen",
  model: "Modell",
  chooseModel: "Modell wählen",
  modelId: "Modell-ID",
  add: "Beratermodell hinzufügen",
  remove: (number) => `Berater ${number} entfernen`,
  most: (max) => `Höchstens ${max} Beratermodelle.`,
  incomplete: "Wähle einen Zugang und ein Modell.",
  leftOut: (reason) => `Ausgelassen, bis er wieder verfügbar ist: ${reason}`,
  reasons: {
    kind: "ChatGPT-Anmeldungen und andere Protokolle können noch nicht beraten",
    keyHeader: "Dieser Endpunkt nimmt seinen Schlüssel in einem eigenen Header",
    unavailable: "Nicht verfügbar",
    missing: "Diesen Zugang gibt es nicht mehr",
  },
  aggregator:
    "Braucht das eigene Modell des Agenten auf einem OpenAI-kompatiblen Endpunkt oder OpenRouter mit Bearer-Schlüssel: Es handelt nach den Ratschlägen. Ändere zuerst das Modell unter Identität.",
  search: {
    moa: "MoA",
    several: "mehrere Modelle",
  },
};
