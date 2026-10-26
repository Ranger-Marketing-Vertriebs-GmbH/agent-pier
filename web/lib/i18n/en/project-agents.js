export const projectAgentsCopy = {
  tab: "Agents",
  title: "Agent access",
  hint: "The same access as in each agent's Access tab: changing it here changes it there.",
  agentsLabel: "Agents with access to this project",
  coding: "May start coding sessions in this project",
  codingHint:
    "Project memory and coding tasks on the pipelines allowed in the agent's Access tab. Folder access needs it.",
  folderLegend: "Folder access",
  folder: { none: "None", read: "Read", write: "Read and write" },
  noAgents: "No permanent agents yet. Create one under Agents.",
  unknownLead: "its lead",
  reloaded:
    "This agent's access was changed elsewhere in the meantime. The current state is shown; choose again.",
  unregistered:
    "Agent access belongs to a registered project folder. Add the folder to assign agents.",
  saving: "Saving …",
  pick: "Agent access (optional)",
  pickHint:
    "Allow agents to use this project right away. You can change it later in the project's Agents tab.",
  pickNone: "No access",
  pickCoding: "Coding only",
  pickRead: "Coding and read folder",
  pickWrite: "Coding, read and write folder",
  pickReadFolder: "Read folder",
  pickWriteFolder: "Read and write folder",
  pickFailed: (count) =>
    count === 1
      ? "The project was added, but access for 1 agent could not be set. Set it in the project's Agents tab."
      : `The project was added, but access for ${count} agents could not be set. Set it in the project's Agents tab.`,
  done: "Done",
};
