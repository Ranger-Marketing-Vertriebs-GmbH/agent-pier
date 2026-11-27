// What an agent's running turn does now (AGENTPIER-184): its live steps, a turn that
// hears nothing from the model, and a chat that grew very long.
export const agentRunStepsCopy = {
  steps: "Steps",
  stepCount: (count) => (count === 1 ? "1 step" : `${count} steps`),
  earlier: (count) => (count === 1 ? "1 earlier step" : `${count} earlier steps`),
  phase: {
    model: "Waiting for the model",
    thinking: "Thinking",
    writing: "Writing the answer",
    tool: "Running a tool",
    approval: "Waiting for approval",
    compacting: "Summarising the chat",
  },
  retrying: (attempt, of) =>
    of
      ? `The model did not answer, trying again (${attempt} of ${of})`
      : "The model did not answer, trying again",
  thinking: "Thought about it",
  tools: {
    exec: "Command",
    process: "Background command",
    image_generate: "Creating an image",
    web_fetch: "Reading a web page",
    web_search: "Searching the web",
    browser: "Using the browser",
    read: "Reading a file",
    write: "Writing a file",
    edit: "Editing a file",
    apply_patch: "Editing files",
    pdf: "Reading a PDF",
    memory_search: "Searching memory",
    memory_get: "Reading memory",
    sessions_search: "Searching earlier chats",
    sessions_history: "Reading an earlier chat",
    sessions_list: "Looking through earlier chats",
    // A question to the person in the chat: OpenClaw's ask_user, Hermes's clarify.
    ask_user: "Asking you a question",
    clarify: "Asking you a question",
  },
  tool: (name) => `Tool ${name}`,
  // An advisor model's answer of a Mixture of Agents turn.
  advisor: (number) => `Advisor ${number}`,
  // Hermes answers a request the advisor's provider could not serve with the agent's
  // own model, under the advisor's name; AgentPier cannot tell which one it was.
  advisorFallback:
    "If this advisor's provider could not serve the request, Hermes answered with the agent's own model instead.",
  advisorFailure: {
    http: (status) => `The advisor's provider answered with HTTP status ${status}.`,
    timeout: "The advisor did not answer in time.",
    connection: "The advisor's provider could not be reached.",
    interrupted: "Skipped: the turn was interrupted.",
    error: "The advisor could not answer.",
  },
  state: {
    running: "Running",
    done: "Done",
    failed: "Failed",
  },
  stalled: (minutes) =>
    minutes === 1
      ? "No answer from the model for 1 minute."
      : `No answer from the model for ${minutes} minutes.`,
  stalledHint:
    "The model may be stuck. Stop the response, or try again: the agent continues where it stopped.",
  continueMessage: "Please continue where you stopped.",
  timedOut:
    "The model did not answer in time. Check what the agent already did before you try again.",
  // The agent service refused the message before running it (server sendRefusal).
  openModelAccess: "Open model access",
  refusedTurn: {
    provider:
      "The model provider refused this message, so the agent could not answer. Check the agent's model connection:",
    degraded:
      "This agent couldn't start in the agent service, so the message was not delivered. Restart the agent service to bring it back.",
    starting:
      "This agent is still starting in the agent service, so the message was not delivered. Try again in a moment.",
    refused: "The agent service refused the message, so it was not delivered. Try again.",
  },
  longChat:
    "This chat is long. After a pause the first reply takes longer, and older details are easier to miss.",
  // The hint in an older chat whose last turns ran on another model family.
  modelHint: "This chat began with another model. Its history can affect the answers.",
  modelHintNewChat: "New chat",
  modelHintDismiss: "Dismiss",
  summarise: "Summarize now",
  dismiss: "Hide",
  // Summarize now asks first: the summary cannot be undone (AGENTPIER-295).
  summariseConfirm: {
    title: "Summarize this chat?",
    body: "Older messages are condensed into a summary. Details in them may get lost, and this cannot be undone.",
    busy: "The chat is busy while the summary runs.",
    confirm: "Summarize",
  },
  compactOutcome: {
    memoryNotSaved: "No memories were saved before the summary.",
    failed: "The summary did not finish. The chat is ready again.",
    nothing: "There was nothing left to summarise. The chat is ready again.",
    busy: "The summary could not start because the agent was busy. The chat is ready again.",
    interrupted:
      "The summary stopped because the agent runtime stopped or restarted. The chat is ready again.",
    unknown:
      "The agent runtime did not report back, so it is unclear whether the summary finished. The chat is ready again.",
  },
};
