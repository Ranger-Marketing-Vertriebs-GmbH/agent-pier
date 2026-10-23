// Quiet chat lines when an agent's memory could not be written, or when a write to a
// shared agent's memory applies to all its users (memory-notes.js).
export const memoryNoteCopy = {
  reasons: {
    "guard-pending":
      "Memory is read-only for this message: write protection is still starting.",
    "not-owner": "Memory not saved: only your own messages can change memory.",
    forwarded: "Memory not saved: forwarded content cannot change memory.",
    automatic: "Memory not saved: scheduled and automatic turns cannot change memory.",
    "lead-request": "Memory not saved: tasks from the lead agent cannot change memory.",
    "peer-request":
      "Memory not saved: requests from another team member cannot change memory.",
    flush:
      "Memory not saved: the automatic note before shortening the conversation was refused.",
    "memory-step":
      "Memory not saved: before a summary, the agent may change only its own memory.",
    "shared-write": "Applies to everyone who uses this agent.",
  },
  unknown: "Memory not saved.",
};
