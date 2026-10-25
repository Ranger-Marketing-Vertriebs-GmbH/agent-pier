export const secretsCopy = {
  title: "Geheimnisse",
  notice:
    "Agenten und Sessions, die ein Geheimnis erhalten, können seinen Wert lesen. Nutze Token mit den geringsten Rechten, die die Aufgabe braucht.",
  add: "Neues Geheimnis",
  loading: "Geheimnisse werden geladen …",
  empty: "Noch keine Geheimnisse.",
  choose: "Wähle ein Geheimnis oder lege ein neues an.",
  back: "Alle Geheimnisse",
  name: "Name",
  nameHint: "Großbuchstaben, Ziffern und Unterstriche, z. B. ZABBIX_TOKEN.",
  description: "Beschreibung",
  project: "Projekt",
  projectHint:
    "Coding-Sessions im Projekt erhalten ein Projektgeheimnis automatisch. Ein globales Geheimnis erhalten nur die Agenten und Sessions, denen du es zuweist.",
  global: "Global",
  unavailableProject: (id) => `Nicht verfügbares Projekt · ${id}`,
  value: "Wert",
  valueSaved: "Wert gespeichert",
  replaceValue: "Wert ersetzen",
  keepValue: "Gespeicherten Wert behalten",
  valueHint: "Nach dem Speichern wird der Wert nie wieder angezeigt.",
  saving: "Wird gespeichert …",
  deleteTitle: (name) => `Geheimnis '${name}' löschen?`,
  deleteBody: "Agenten und Sessions verlieren dieses Geheimnis sofort.",
  launchHint:
    "Geheimnisse des eigenen Projekts der Session sind immer dabei. Die Session findet ihre Geheimnisse in einer Datei außerhalb des Checkouts und kann ihre Werte lesen.",
  launchSummary: (count) => `${count} ${count === 1 ? "Geheimnis" : "Geheimnisse"}`,
  errors: {
    SECRET_NAME_TAKEN: "Ein Geheimnis mit diesem Namen existiert bereits.",
    SECRET_LIMIT: "Es sind höchstens 200 Geheimnisse möglich.",
    SECRET_NOT_FOUND: "Dieses Geheimnis existiert nicht mehr. Lade die Seite neu.",
  },
};
