export const craftAnythingCopy = {
  title: "Craft Anything",
  searchLabel: "Craft Anything",
  intro:
    "Craft Anything gibt Claude Code Tools, um Anwendungen zu untersuchen, und den Skill dazu. AgentPier lädt die festgelegte Version, prüft Größe und SHA-256 und legt sie in einen eigenen Ordner, getrennt von deiner eigenen Konfiguration. Die Installation trägt Craft Anything bei den CLIs ein, an die es gebunden ist (standardmäßig Claude Code), und kopiert seinen Skill in die Profile dieser CLIs.",
  loading: "Craft Anything wird geladen …",
  componentsLabel: "Bestandteile",
  core: "Craft Anything",
  coreDescription: "Die Craft-Anything-CLI als MCP-Server, mit ihrem Skill. Immer dabei.",
  deepMode: "Tiefer Modus für Sessions",
  deepModeHint:
    "Ist er aus, arbeiten Sessions im Clean-Room-Modus: Sie lesen nichts im Inneren eines Ziels und nutzen nur Tools, die von außen arbeiten. Ist er an, dürfen sie auch in ein Ziel hineinschauen und es etwa mit Ghidra dekompilieren.",
  responsibleLabel: "Verantwortungsvolle Nutzung",
  responsibleOwn:
    "Untersuche nur Software, die dir gehört oder die du untersuchen darfst.",
  responsibleBypass:
    "Nutze Craft Anything nie, um DRM, Anmeldungen oder Anti-Cheat-Systeme zu umgehen.",
  responsibleAlpha:
    "Craft Anything ist in einer frühen Alpha. Rechne mit Ecken, Kanten und Änderungen.",
  responsibleRestricted:
    "Sessions bekommen die Analyse-Tools im eingeschränkten Modus: Sie führen den untersuchten Code nie aus und starten keine Nachbauten.",
  responsibleCleanRoom:
    "Sessions arbeiten standardmäßig im Clean-Room-Modus. Den tiefen Modus wählst du unten.",
  acknowledge:
    "Ich habe diese Hinweise verstanden und nutze Craft Anything nur für Software, die mir gehört oder die ich untersuchen darf.",
  updateNote: (parts) => `Ein Update ist verfügbar: ${parts}.`,
  updateCore: (version) => `Craft Anything ${version}`,
  swapFailed:
    "Laufende Sessions konnten nicht auf die installierte Version wechseln und behalten ihre bisherige. Sie versuchen es beim nächsten Update erneut.",
  runningOlder: (versions) =>
    `Laufende Sessions nutzen noch Version ${versions} bis zum Neuladen.`,
  statusRunning: "Craft Anything wird geändert …",
  backgroundNote:
    "Du kannst dieses Fenster schließen. Craft Anything arbeitet im Hintergrund weiter.",
  remove: "Craft Anything entfernen",
  removeTitle: "Craft Anything entfernen?",
  removeBody:
    "AgentPier entfernt den MCP-Server von Craft Anything, seine Skill-Kopien, die CLI und ihre Einstellungen. Ghidra und die Java-Laufzeit gehen mit, außer REA nutzt sie noch. Laufende Sessions behalten die Tools, bis sie neu geladen werden.",
};
