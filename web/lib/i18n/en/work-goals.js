// An agent's work goal in its owner's chat: the open goal with Stop, and its notes.
export const workGoalCopy = {
  line: (t) => `Working until done: ${t}`,
  stop: "Stop",
  stopFailed: "The goal could not be stopped. Try again.",
  // A turn AgentPier sent so the agent keeps working on the goal.
  continuing: (t) => `Continuing · ${t}`,
  notes: {
    set: (t) => `Working until done: ${t}`,
    done: (t) => `Goal done: ${t}`,
    blocked: (t) => `Goal blocked: ${t}`,
    stopped: (t) => `Goal stopped: ${t}`,
    replaced: (t) => `Goal replaced: ${t}`,
    ended: (t) => `Goal ended: ${t}`,
  },
  // Why AgentPier ended a goal by itself.
  reasons: {
    technical: "The model failed several times in a row.",
    "no-progress": "Several continuations brought no progress.",
    proof: "Your message that set the goal is no longer available.",
    archived: "The chat or agent was archived.",
    ineligible: "This agent can no longer keep goals.",
    "turn-cancelled": "You stopped the agent's turn.",
  },
};
