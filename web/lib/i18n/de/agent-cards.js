// Agent-Karten im Agenten-Chat: interaktive Karten, die ein Agent in den Chat legt
// (web/features/assistants/cards/).
export const agentCardsCopy = {
  label: (title) => `Karte: ${title}`,
  version: (n) => `Version ${n}`,
  updated: "aktualisiert",
  frozen: "Diese Karte ist geschlossen: Neuere Karten dieses Chats haben sie abgelöst.",
  moved: (title) => `„${title}“ wurde aktualisiert – weiter unten`,
  showMoved: (title) => `Aktualisierte Karte „${title}“ zeigen`,
  chart: (title) => (title ? `Diagramm: ${title}` : "Diagramm"),
  states: { ok: "OK", warn: "Warnung", fail: "Problem", unknown: "Unbekannt" },
  readOnly: "Nur die Person, der dieser Chat gehört, kann diese Karte nutzen.",
  waiting: "Die Knöpfe gehen wieder, sobald der Agent geantwortet hat.",
};
