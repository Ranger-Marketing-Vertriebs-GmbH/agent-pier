export const projectsHubCopy = {
  topline: "WORKSPACE / PROJECTS",
  subtle: "Stored locally",
  title: "Projects",
  description:
    "From repository to your next session. Knowledge, AgentBus and runs per project.",
  addFolder: "Add folder",
  listLabel: "Projects",
  loading: "Loading projects …",
  localOnly: "Local only",
  decisions: (count) =>
    count === 1 ? "1 decision required" : `${count} decisions required`,
  failedRuns: (count) => (count === 1 ? "1 run failed" : `${count} runs failed`),
  tokenMeta: (name) => `Token ${name}`,
  back: "All projects",
  openProject: (name) => `Open project ${name}`,
  tabsLabel: "Project sections",
  tabOverview: "Overview",
  tabKnowledge: "Project knowledge",
  tabAgentBus: "AgentBus",
  tabRuns: "Runs",
  notFound: "Project not found",
  notFoundDescription:
    "This project no longer exists. Choose another project from the list.",
  runsLink: "View runs in Pipelines",
  runsDescription: "Pipeline runs for this project are listed under Pipelines.",
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
};
