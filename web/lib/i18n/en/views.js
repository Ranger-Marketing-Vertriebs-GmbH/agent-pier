export const viewsCopy = {
  openAlone: "Open alone",
  paneMenu: (name) => `More for ${name}`,
  removePane: (name) => `Remove ${name} from the view`,
  nameLabel: "View name",
  rename: "Rename view",
  deleteView: "Delete view",
  deleteBody: (name) => `“${name}” is deleted. Sessions and chats stay as they are.`,
  empty: "This view is empty. Drag a session or an agent from the sidebar here.",
  paneHint: (n) => `${n} of 6 panes`,
  narrowNote:
    "Panes side by side need a window wider than 1150 px. The first pane is shown here.",
  sessionRemoved: "Session removed",
  chatDeleted: "Chat deleted",
  agentDeleted: "Agent deleted",
  agentsOff: "Agents are switched off",
  disconnected: "Disconnected",
  removeStale: "Remove from view",
};
