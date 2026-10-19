// What a lead agent shares of its own access with its permanent members, as the
// owner sees and revokes it (server lead-shares.js).
export const leadShareCopy = {
  title: "Shared by the lead agent",
  hint: "The lead agent shares its own access with this permanent member: project folders, coding projects and MCP servers. It counts only while the lead holds it, in the lead's tasks and in your own chats with this member. Coding runs still need your approval, and files change only in tasks that may change files.",
  empty: "The lead agent shares nothing with this member.",
  loading: "Loading shares …",
  folder: { read: "Folder: read", write: "Folder: read and write" },
  coding: "Coding",
  mcpServer: (name) => `MCP server ${name}`,
  unknownProject: "Project no longer readable",
  unknownServer: "Server no longer readable",
  forTask: "For one task",
  standing: "Standing",
  via: (lead) => `via ${lead}`,
  inactive: "Not in effect: the lead agent does not hold it right now",
  revoke: "Revoke",
  revokeLabel: (what, member) => `Revoke ${what} for ${member}`,
  confirmTitle: (what, member) => `Revoke ${what} for ${member}?`,
  confirmBody: (lead) =>
    `The member loses this access at once; waiting coding requests on it fail. ${lead} can share it again.`,
  confirmLabel: "Revoke now",
  projectSection: "Shared by lead agents",
  projectHint:
    "Permanent members using this project through their lead agent. It counts only while the lead holds it.",
  serverShared: "Used through a lead agent",
};

// The owner's one tap after a lead agent was refused a change while it handled a
// member's result (server conversations.js goAheadMarks).
export const goAheadCopy = {
  button: "Go ahead",
  message: "Yes, go ahead",
  hint: "The lead agent may not change anything while it handles a member's result. Tap to give it your go-ahead.",
};
