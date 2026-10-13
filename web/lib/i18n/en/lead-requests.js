// A lead agent's questions and tasks for its own team members.
export const leadRequestCopy = {
  // The meta line under a member chat message its lead sent.
  from: (name) => `from ${name}`,
  at: (from, time) => `${from} · ${time}`,
  spokenAt: (from, time) => `${from}, ${time}`,
  permanentSection: "Permanent",
  temporarySection: "Temporary",
  types: { question: "Question", task: "Task" },
  title: (type, member) =>
    type === "task" ? `Task for ${member}` : `Question for ${member}`,
  states: {
    awaiting_approval: "Awaiting approval",
    queued: "Waiting for the member",
    dispatching: "Sending",
    running: "In progress",
    uncertain: "Outcome unknown",
    completed: "Done",
    answered: "Answered",
    failed: "Failed",
    cancelled: "Cancelled",
    declined: "Declined",
  },
  approvalHint:
    "Your agent wants to send this to its member. It is sent once you approve and the member is free.",
  shell: (level) =>
    `Member's shell access: ${{ off: "off", approval: "with approval", full: "full" }[level] || level}`,
  mcp: (names) => `Member's MCP servers: ${names}`,
  noMcp: "Member's MCP servers: none",
  mcpUnavailable: "The member's MCP servers cannot be listed right now.",
  stdio: (name) => `${name} (stdio, local command)`,
  writesIfApproved: (member) =>
    `If you approve, ${member} may change files in its own workspace (not its memory).`,
  writes: (member) => `${member} may change files in its own workspace (not its memory).`,
  readOnly: (member) => `${member} does not change files for this task.`,
  showAll: "Show all",
  followUpFailed: "The result could not be passed back to the agent. Read it here.",
  approve: "Approve",
  decline: "Decline",
  cancel: "Cancel",
  listTitle: "Questions and tasks",
  listHint:
    "What this agent asked its members or gave them to do, open ones first. Answers also appear in the members' chats.",
  open: (count) => `Open (${count})`,
  finished: (count) => `Finished (${count})`,
  none: "This agent has not asked its members anything yet.",
  answer: "Answer",
  result: "Result",
  because: (quote) => `Because you wrote: “${quote}”`,
};
