// Agents › Skills: the owner's skill catalog for all agents (SkillCatalogTab.jsx).
export const agentSkillCatalogCopy = {
  lead: "Schalte einen Skill hier oder unter Agent › Fähigkeiten › Skills für Agenten ein. AgentPier prüft jeden Skill, bevor er installiert wird.",
  searchPlaceholder: "Name oder Beschreibung",
  filterUsed: "In Nutzung",
  filterUnused: "Ungenutzt",
  filterFindings: "Mit Befunden",
  usage: (count) => (count === 1 ? "1 Agent" : `${count} Agenten`),
  unused: "Ungenutzt",
  groupUploaded: "Hochgeladen",
  groupGithub: "GitHub",
  whenUsed: "Wann der Agent ihn nutzt",
  switchesLabel: "Eingeschaltet für",
  noAgents: "Noch kann kein Agent Skills nutzen.",
  switchLabel: (skill, agent) => `${skill} für ${agent}`,
  factsLabel: "Herkunft und Prüfung",
  factPrograms: "Programme",
  factState: "Zustand",
  sourceUpload: "Upload",
  programsNone: "Keine",
  programsPending: "Werden angezeigt, sobald der Agentendienst läuft",
  listLabel: "Katalog-Skills",
  loading: "Skill-Katalog wird geladen …",
  empty:
    "Noch keine Skills im Katalog. Installiere einen Skill, um ihn für deine Agenten einzuschalten.",
  install: "Skill installieren",
  destinationLabel: "Ziel",
  destination: "Skill-Katalog für alle Agenten",
  installTitle: "Skill für alle Agenten installieren",
  sourceLimits:
    "Ein Skill oder ein Repository, Ordner oder ZIP mit mehreren Skills zur Auswahl · ZIP-Upload bis 10 MiB, GitHub-Archiv bis 50 MiB, 20 MiB pro Skill. Installiert werden nur die Skill-Ordner. Installationsskripte werden nicht ausgeführt. Vor der Installation prüft AgentPier die Dateien offline und zeigt das Ergebnis.",
  installAction: "In den Katalog aufnehmen",
  updateTitle: "Neue Version hochladen",
  checkedUpdateTitle: "Skill aktualisieren",
  updateAction: "Update installieren",
  installedNotice: "Skill in den Katalog aufgenommen.",
  updatedNotice:
    "Skill aktualisiert. Agenten, die ihn nutzen, bekommen die neue Version.",
  overridden: "Blockiert, trotzdem installiert",
  oneOf: (programs) => `eines von ${programs}`,
  needsSettings: "Braucht Einstellungen — noch nicht unterstützt",
  shadowed: "Von einem mitgelieferten Skill verdeckt",
  shadowedSource: "Von einem anderen installierten Skill gleichen Namens verdeckt",
  unavailable: "Gerade nicht verfügbar \u2014 AgentPier prüft ihn erneut",
  damaged: "Beschädigt — installiere ihn neu",
  agentsOn: (count) =>
    count === 1 ? "Für 1 Agenten eingeschaltet" : `Für ${count} Agenten eingeschaltet`,
  agentsNone: "Für keinen Agenten eingeschaltet",
  checkUpdate: "Nach Update suchen",
  checking: (name) => `Suche nach einem Update für ${name} …`,
  upToDate: (name) => `Auf dem neuesten Stand: Für ${name} gibt es keine neuere Version.`,
  checkUpdates: "Nach Updates suchen",
  checkUpdatesLabel: (source) => `In ${source} nach Updates suchen`,
  checkingSource: (source) => `Suche nach Updates in ${source} …`,
  sourceUpToDate: (source, more) =>
    `Auf dem neuesten Stand: Für keinen Skill aus ${source} gibt es eine neuere Version.` +
    (more
      ? more === 1
        ? " Das Repository enthält 1 weiteren Skill; du nimmst ihn über „Skill installieren“ auf."
        : ` Das Repository enthält ${more} weitere Skills; du nimmst sie über „Skill installieren“ auf.`
      : ""),
  sourceUpdateTitle: "Skills aktualisieren",
  sourceInstallAction: (count) =>
    count === 1 ? "1 Skill installieren" : `${count} Skills installieren`,
  sourceInstalledNotice: (done, skipped) =>
    (done === 1 ? "1 Skill installiert." : `${done} Skills installiert.`) +
    " Agenten, die sie nutzen, bekommen die neue Version." +
    (skipped
      ? skipped === 1
        ? " 1 Skill wurde übersprungen."
        : ` ${skipped} Skills wurden übersprungen.`
      : ""),
  uploadVersion: "Neue Version hochladen",
  removeTitle: (name) => `Skill „${name}“ entfernen?`,
  removeBody: "Der Skill verlässt den Katalog, seine Dateien werden gelöscht.",
  removeAgents: (names) => `Durch das Entfernen wird er ausgeschaltet für: ${names}.`,
  removeUnused: "Kein Agent nutzt ihn.",
  removedNotice: (name) => `Skill „${name}“ entfernt.`,
};
