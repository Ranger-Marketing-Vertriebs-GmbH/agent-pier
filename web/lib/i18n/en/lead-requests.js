// A lead agent's questions and tasks for its own team members.
export const leadRequestCopy = {
  // The meta line under a member chat message its lead sent.
  from: (name) => `from ${name}`,
  at: (from, time) => `${from} · ${time}`,
  spokenAt: (from, time) => `${from}, ${time}`,
  permanentSection: "Permanent",
  temporarySection: "Temporary",
  title: (type, member) =>
    type === "task" ? `Task for ${member}` : `Question for ${member}`,
  states: {
    queued: "Waiting for the member",
    dispatching: "Sending",
    running: "In progress",
    uncertain: "Outcome unknown",
    completed: "Done",
    answered: "Answered",
    failed: "Failed",
    cancelled: "Cancelled",
  },
  // A task may write only when the owner explicitly asked for it.
  mayWrite: "may write",
  readOnly: "read-only",
  // The lead started it on its own (team usage "Autonomous").
  selfInitiated: "self-initiated",
  // Asked or delegated by one of the lead's routines; its tasks never write.
  routine: (name) => (name ? `Scheduled · ${name}` : "Scheduled"),
  showAll: "Show all",
  // An answer stored incomplete beyond the history limit.
  answerShortened: "Shortened – the whole text is in the member’s chat.",
  openMemberChat: "Open chat",
  followUpFailed: "The result could not be passed back to the agent. Read it here.",
  listTitle: "Questions and tasks",
  listHint:
    "What this agent asked its members or gave them to do, open ones first. A task may change files in the member's workspace only when you asked for it yourself, or when the agent uses its team autonomously and started it in reply to your message (marked self-initiated). Answers also appear in the members' chats.",
  open: (count) => `Open (${count})`,
  finished: (count) => `Finished (${count})`,
  none: "This agent has not asked its members anything yet.",
  answer: "Answer",
  result: "Result",
  because: (quote) => `Because you wrote: “${quote}”`,
  // The @mention autocomplete in a lead's composer and the chips in its chat.
  mentions: {
    list: "Team members",
    permanent: "Permanent",
    temporary: "Temporary",
    open: (name) => `Open the chat with ${name}`,
  },
};
