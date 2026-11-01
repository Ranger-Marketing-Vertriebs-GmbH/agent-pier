export const viewsCopy = {
  group: "Ansichten",
  newView: "Neue Ansicht",
  defaultName: (n) => `Ansicht ${n}`,
  rowLabel: (name, n) => `${name}, ${n} Bereiche`,
  openAlone: "Einzeln öffnen",
  paneMenu: (name) => `Mehr zu ${name}`,
  removePane: (name) => `${name} aus der Ansicht nehmen`,
  nameLabel: "Name der Ansicht",
  rename: "Ansicht umbenennen",
  deleteView: "Ansicht löschen",
  deleteBody: (name) => `„${name}“ wird gelöscht. Sessions und Chats bleiben erhalten.`,
  empty:
    "Diese Ansicht ist leer. Zieh eine Session oder einen Agenten aus der Seitenleiste hierher.",
  paneHint: (n) => `${n} von 6 Bereichen`,
  narrowNote:
    "Mehrere Bereiche nebeneinander gibt es ab 1151 px Fensterbreite. Hier siehst du den ersten Bereich.",
  sessionRemoved: "Session entfernt",
  chatDeleted: "Chat gelöscht",
  agentDeleted: "Agent gelöscht",
  agentsOff: "Agenten sind ausgeschaltet",
  disconnected: "Getrennt",
  removeStale: "Aus der Ansicht nehmen",
};
