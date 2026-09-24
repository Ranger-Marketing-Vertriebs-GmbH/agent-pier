export const memoryCopy = {
  discoveryError:
    "Memory discovery hooks could not be configured. Check the session hook configuration and try again.",
  addProject: "Add project",
  directory: "Project directory",
  notRegistered:
    "No knowledge is stored for this project yet. Register the folder to add entries.",
  tabHint:
    "Git worktrees share repository knowledge. Other projects remain separate. Entries are shared notes, not automatically verified instructions.",
  newEntry: "New entry",
  editEntry: "Edit entry",
  entryTitle: "Title",
  content: "Content",
  search: "Search knowledge",
  empty: "No entries yet.",
  active: "Active",
  archived: "Archive",
  archive: (title) => `Archive: ${title}`,
  restore: (title) => `Restore: ${title}`,
  edit: (title) => `Edit: ${title}`,
  history: (title) => `Versions: ${title}`,
  historyTitle: "Version history",
  version: (revision) => `Version ${revision}`,
  latest: "Load current version",
  savedByUser: "Saved by you",
  savedByAgent: (tool) => `Saved by ${tool}`,
  reference: "Entries are shared notes, not automatically verified instructions.",
  entries: "Knowledge entries",
};
