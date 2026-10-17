export const memoryCopy = {
  savedByAssistant: "Saved by an agent",
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
  countsUnavailable: "The entry counts could not be loaded.",
  archive: (title) => `Archive: ${title}`,
  restore: (title) => `Restore: ${title}`,
  edit: (title) => `Edit: ${title}`,
  history: (title) => `Versions: ${title}`,
  forget: (title) => `Forget permanently: ${title}`,
  forgetAction: "Forget permanently",
  forgetTitle: "Forget entry permanently",
  forgetWarning:
    "This deletes the entry and all of its versions from the knowledge database. It cannot be undone. Storing the identical title and content again in this project is refused; another entry that already holds the same text is not removed.",
  forgetLimit:
    "Only identical text is blocked: the same secret inside different text can still be written.",
  forgetArchives:
    "Existing backup archives under Settings → Operations → Backups still contain the content. Delete or handle them by hand.",
  forgetReason: "Reason (optional; never enter the secret itself)",
  forgetRemoveBackups: (count) =>
    `Also delete the ${count === 1 ? "migration backup" : `${count} migration backups`} of the knowledge database (memory.sqlite.*) on this computer`,
  forgetIncomplete:
    "The entry is forgotten, but the knowledge database files are not fully cleaned yet. AgentPier retries at the next start and the next time you forget an entry.",
  forgetRecordsIncomplete:
    "Agent action records still contain the text. AgentPier retries removing it at the next start and the next time you forget an entry.",
  historyTitle: "Version history",
  version: (revision) => `Version ${revision}`,
  latest: "Load current version",
  savedByUser: "Saved by you",
  savedByAgent: (tool) => `Saved by ${tool}`,
  reference: "Entries are shared notes, not automatically verified instructions.",
  entries: "Knowledge entries",
};
