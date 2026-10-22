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
  },
  tool: (name) => `Tool ${name}`,
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
  longChat:
    "This chat is long. After a pause the first reply takes longer, and older details are easier to miss.",
  summarise: "Summarise now",
  dismiss: "Hide",
  compactOutcome: {
    failed: "The summary did not finish. The chat is ready again.",
    nothing: "There was nothing left to summarise. The chat is ready again.",
    busy: "The summary could not start because the agent was busy. The chat is ready again.",
    interrupted:
      "The summary stopped because the agent runtime restarted. The chat is ready again.",
    unknown:
      "The summary did not report back within an hour, so it is unclear whether it finished. The chat is ready again.",
  },
};
