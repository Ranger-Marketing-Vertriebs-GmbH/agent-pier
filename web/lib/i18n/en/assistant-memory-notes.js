// Quiet chat lines when an agent's memory could not be written (memory-notes.js).
export const memoryNoteCopy = {
  reasons: {
    "guard-pending":
      "Memory is read-only for this message: write protection is still starting.",
    "not-owner": "Memory not saved: only your own messages can change memory.",
    "lead-request": "Memory not saved: tasks from the lead agent cannot change memory.",
    flush:
      "Memory not saved: the automatic note before shortening the conversation was refused.",
  },
  unknown: "Memory not saved.",
};
