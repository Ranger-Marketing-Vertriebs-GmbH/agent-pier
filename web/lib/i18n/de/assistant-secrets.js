export const assistantSecretsCopy = {
  row: "Geheimnisse",
  none: "Keine",
  summary: (count) => `${count} ${count === 1 ? "Geheimnis" : "Geheimnisse"}`,
  title: "Geheimnisse",
  intro:
    "Geheimnisse, die dieser Agent erhält. Er findet sie in .agentpier/secrets.env in seinem Arbeitsbereich und kann ihre Werte lesen.",
  search: "Geheimnisse suchen",
  noMatch: "Kein Geheimnis passt zur Suche.",
  empty: "Es gibt noch keine Geheimnisse.",
  manage: "Geheimnisse einrichten",
  loading: "Geheimnisse werden geladen …",
  loadError: "Geheimnisse konnten nicht geladen werden.",
  global: "Global",
  project: (name) => `Projekt: ${name}`,
};
