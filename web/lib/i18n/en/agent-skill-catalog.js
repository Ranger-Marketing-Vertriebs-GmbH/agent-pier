// Agents › Skills: the owner's skill catalog for all agents (SkillCatalogTab.jsx).
export const agentSkillCatalogCopy = {
  lead: "Switch a skill on for agents here or under Agent › Capabilities › Skills. AgentPier scans every skill before it is installed.",
  searchPlaceholder: "Name or description",
  filterUsed: "In use",
  filterUnused: "Unused",
  filterFindings: "With findings",
  usage: (count) => (count === 1 ? "1 agent" : `${count} agents`),
  unused: "Unused",
  groupUploaded: "Uploaded",
  groupGithub: "GitHub",
  whenUsed: "When the agent uses it",
  switchesLabel: "Switched on for",
  noAgents: "No agent can use skills yet.",
  switchLabel: (skill, agent) => `${skill} for ${agent}`,
  factsLabel: "Origin and scan",
  factPrograms: "Programs",
  factState: "State",
  sourceUpload: "Upload",
  programsNone: "None",
  programsPending: "Shown once the agent service runs",
  listLabel: "Catalog skills",
  loading: "Loading the skill catalog …",
  empty: "No skills in the catalog yet. Install a skill to switch it on for your agents.",
  install: "Install skill",
  destinationLabel: "Destination",
  destination: "Skill catalog for all agents",
  installTitle: "Install skill for all agents",
  installAction: "Add to catalog",
  sourceLimits:
    "One skill, or a repository, folder or ZIP with several skills to choose from · ZIP upload up to 10 MiB, GitHub archive up to 50 MiB, 20 MiB per skill. Only the skill folders are installed. Installation scripts are not executed. Before installing, AgentPier checks the files offline and shows the result.",
  updateTitle: "Upload new version",
  checkedUpdateTitle: "Update skill",
  updateAction: "Install update",
  installedNotice: "Skill added to the catalog.",
  updatedNotice: "Skill updated. Agents that use it get the new version.",
  overridden: "Blocked, installed anyway",
  oneOf: (programs) => `one of ${programs}`,
  needsSettings: "Needs settings — not supported yet",
  shadowed: "Shadowed by a bundled skill",
  shadowedSource: "Shadowed by another installed skill of the same name",
  unavailable: "Not available right now \u2014 AgentPier will check it again",
  damaged: "Damaged — install it again",
  agentsOn: (count) => (count === 1 ? "On for 1 agent" : `On for ${count} agents`),
  agentsNone: "Not switched on for any agent",
  checkUpdate: "Check for update",
  checking: (name) => `Checking ${name} for an update …`,
  upToDate: (name) => `Up to date: there is no newer version of ${name}.`,
  checkUpdates: "Check for updates",
  checkUpdatesLabel: (source) => `Check ${source} for updates`,
  checkingSource: (source) => `Checking ${source} for updates …`,
  sourceUpToDate: (source, more) =>
    `Up to date: no skill from ${source} has a newer version.` +
    (more
      ? more === 1
        ? " The repository has 1 more skill; add it with Install skill."
        : ` The repository has ${more} more skills; add them with Install skill.`
      : ""),
  sourceUpdateTitle: "Update skills",
  sourceInstallAction: (count) =>
    count === 1 ? "Install 1 skill" : `Install ${count} skills`,
  sourceInstalledNotice: (done, skipped) =>
    (done === 1 ? "1 skill installed." : `${done} skills installed.`) +
    " Agents that use them get the new version." +
    (skipped
      ? skipped === 1
        ? " 1 skill was skipped."
        : ` ${skipped} skills were skipped.`
      : ""),
  uploadVersion: "Upload new version",
  removeTitle: (name) => `Remove skill “${name}”?`,
  removeBody: "The skill leaves the catalog and its files are deleted.",
  removeAgents: (names) => `Removing it switches it off for: ${names}.`,
  removeUnused: "No agent uses it.",
  removedNotice: (name) => `Skill “${name}” removed.`,
};
