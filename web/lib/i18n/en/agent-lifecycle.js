// Archive, restore and permanent delete of any agent (agent-lifecycle.js on the server).
export const agentLifecycleCopy = {
  archive: "Archive",
  restore: "Restore",
  deletePermanently: "Delete permanently",
  deleteHint: "Chats, memory and workspace are deleted for good",
  membersTitle: (name, count) =>
    count === 1
      ? `Archive ${name} and its temporary member?`
      : `Archive ${name} and its ${count} temporary members?`,
  membersBody:
    "Its temporary team members are archived with it. Permanent members stay. You can restore them later.",
  deleteTitle: (name) => `Delete ${name} permanently?`,
  deleteBody:
    "This cannot be undone. Earlier backups still contain the agent, and the activity log keeps its entries.",
  counting: "Counting what is deleted …",
  lost: "Deleted with it:",
  chats: (count) => (count === 1 ? "1 chat" : `${count} chats`),
  routines: (count) =>
    count === 1
      ? "1 routine, reminder or hook"
      : `${count} routines, reminders and hooks`,
  memoryFiles: (count) =>
    count === 1 ? "1 note or memory file" : `${count} notes and memory files`,
  workspaceFiles: (count) =>
    count === 1 ? "1 workspace file" : `${count} workspace files`,
  members: (count) =>
    count === 1 ? "1 temporary team member" : `${count} temporary team members`,
  kept: "Project memory, coding runs and pipeline runs it started stay.",
  typeName: (name) => `Type “${name}” to confirm`,
};
