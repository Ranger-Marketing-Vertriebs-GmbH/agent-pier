// Agents › Skills: the owner's skill catalog for all agents (SkillCatalogTab.jsx).
const short = (commit) => String(commit).slice(0, 7);

export const agentSkillCatalogCopy = {
  lead: "Skills aus dem Katalog kannst du für jeden Agenten unter Agent › Fähigkeiten › Skills einschalten. AgentPier prüft jeden Skill, bevor er installiert wird.",
  listLabel: "Katalog-Skills",
  loading: "Skill-Katalog wird geladen …",
  empty:
    "Noch keine Skills im Katalog. Installiere einen Skill, um ihn für deine Agenten einzuschalten.",
  install: "Skill installieren",
  destinationLabel: "Ziel",
  destination: "Skill-Katalog für alle Agenten",
  installTitle: "Skill für alle Agenten installieren",
  installAction: "In den Katalog aufnehmen",
  updateTitle: "Neue Version hochladen",
  updateAction: "Update installieren",
  installedNotice: "Skill in den Katalog aufgenommen.",
  updatedNotice:
    "Skill aktualisiert. Agenten, die ihn nutzen, bekommen die neue Version.",
  versionUpload: (version) => `Version ${version} · aus einem Upload`,
  versionGithub: (version, repository, ref, commit) =>
    `Version ${version} · von GitHub ${repository} @ ${ref} (${short(commit)})`,
  versionGithubPlain: (version) => `Version ${version} · von GitHub`,
  overridden: "Blockiert, trotzdem installiert",
  runsPrograms: (programs) => `Führt Programme aus: ${programs}`,
  oneOf: (programs) => `eines von ${programs}`,
  programsPending: "Programme: werden angezeigt, sobald der Agentendienst läuft",
  needsSettings: "Braucht Einstellungen — noch nicht unterstützt",
  shadowed: "Von einem mitgelieferten Skill verdeckt",
  damaged: "Beschädigt — installiere ihn neu",
  agentsOn: (count) => (count === 1 ? "Für 1 Agenten an" : `Für ${count} Agenten an`),
  agentsNone: "Für keinen Agenten eingeschaltet",
  rowActions: (name) => `Aktionen für ${name}`,
  checkUpdate: "Nach Update suchen",
  checking: (name) => `Suche nach einem Update für ${name} …`,
  upToDate: (name) => `Aktuell: Für ${name} gibt es keine neuere Version.`,
  uploadVersion: "Neue Version hochladen",
  removeTitle: (name) => `Skill „${name}“ entfernen?`,
  removeBody: "Der Skill verlässt den Katalog, seine Dateien werden gelöscht.",
  removeAgents: (names) => `Durch das Entfernen wird er ausgeschaltet für: ${names}.`,
  removeUnused: "Kein Agent nutzt ihn.",
  removedNotice: (name) => `Skill „${name}“ entfernt.`,
};
