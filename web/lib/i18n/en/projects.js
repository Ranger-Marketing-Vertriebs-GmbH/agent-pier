export const projectsHubCopy = {
  topline: "WORKSPACE / PROJECTS",
  subtle: "Stored locally",
  title: "Projects",
  description:
    "From repository to your next session. Knowledge, AgentBus and runs per project.",
  addFolder: "Add folder",
  listLabel: "Projects",
  loading: "Loading projects …",
  partialError:
    "Not every project source could be loaded. The other projects stay available.",
  localOnly: "Local only",
  decisions: (count) =>
    count === 1 ? "1 decision required" : `${count} decisions required`,
  failedRuns: (count) => (count === 1 ? "1 run failed" : `${count} runs failed`),
  tokenMeta: (name) => `Token ${name}`,
  back: "All projects",
  tabsLabel: "Project sections",
  tabOverview: "Overview",
  tabKnowledge: "Project knowledge",
  tabAgentBus: "AgentBus",
  tabRuns: "Runs",
  notFound: "Project not found",
  notFoundDescription:
    "This project no longer exists. Choose another project from the list.",
  runsUnavailable:
    "Runs belong to a project folder. Add the folder to start pipelines in it.",
};
export const projectOverviewCopy = {
  factsLabel: "Project details",
  remote: "Remote",
  branch: "Branch",
  tokenProfile: "Token profile",
  folder: "Folder",
  noToken: "None",
  sessions: (count) => `Sessions · ${count}`,
  noSessions: "No sessions in this project yet.",
  open: "Open",
  openSession: (name) => `Open session ${name}`,
  justNow: "just now",
};
export const projectDialogsCopy = {
  noToken: "No token",
  cloneContinues: "Cloning continues if you close this dialog.",
  addFolderDescription:
    "Registers an existing folder as a project for knowledge, AgentBus and runs.",
  mergeOlder: "Merge older entry",
  mergeOlderDescription: (name, date) =>
    `An older project entry “${name}” from ${date} belongs to this folder. Merging moves everything it holds into this project.`,
  mergeMoves: "What moves",
  mergeLoading: "Counting what moves …",
  mergeEntries: (count) => `Memory entries: ${count}`,
  mergeCapabilities: (count) => `Memory accesses of sessions: ${count}`,
  mergeSsh: (count) => `SSH keys and hosts: ${count}`,
  mergeArtifacts: (count) => `Artifacts: ${count}`,
  mergeVerification: (count) => `Verification steps: ${count}`,
  mergeSessions: (count) => `Sessions: ${count}`,
  mergeWarning:
    "SSH access and the permissions of sessions that used the older entry move to the current folder. This cannot be undone.",
  mergeConfirm: "Merge",
};
