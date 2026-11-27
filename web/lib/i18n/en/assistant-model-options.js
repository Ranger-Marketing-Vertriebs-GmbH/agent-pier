// How an OpenClaw agent's model works (the Identity tab, below the model): the
// runtime's own surface (web/features/assistants/runtimes/openclaw/).
export const assistantModelOptionsCopy = {
  title: "Model behaviour",
  hint: "How this agent's model works. A setting left on “Default” follows the setting for all agents and the model's own default.",
  inherit: "Default",
  thinking: {
    label: "Thinking level",
    sub: "How thoroughly the model thinks before it answers. A level the model does not have is replaced by the closest one.",
  },
  fast: {
    label: "Fast mode",
    sub: "Asks the provider for faster answers where it offers that, such as priority processing at OpenAI and Anthropic. This can cost more; other models ignore it.",
    on: "On",
    off: "Off",
  },
  loop: {
    label: "Loop protection",
    sub: "Ends a turn in which the model keeps repeating the same tool call without getting anywhere. On by default for a model of your own endpoint, which is often a small or local model.",
  },
  fallback: {
    label: "Fallback models",
    sub: "When this agent's model cannot answer, the first fallback model that can answers the same message instead, in this order: at once when a key is refused or the model is gone, and after the retries of a failing or rate-limited provider, which can take a few minutes. The next message tries the agent's own model first again. A fallback's provider then receives the conversation; a fallback that takes no images answers without them.",
    none: "None",
    connection: (number) => `Fallback ${number}: connection`,
    model: (number) => `Fallback ${number}: model`,
    modelId: (number) => `Fallback ${number}: model ID`,
    chooseConnection: "Choose a connection",
    chooseModel: "Choose a model",
    add: "Add a fallback model",
    remove: (number) => `Remove fallback ${number}`,
    incomplete: "Choose a connection and a model.",
    ownModel: "This is the agent's own model. Choose another one.",
    incompleteSave:
      "Choose a connection and a model for every fallback model, or remove it, to save.",
    twiceSave: "Each fallback model must be a different model.",
    leftOut: (reason) => `Left out until it is available again: ${reason}`,
    reasons: {
      kind: "A ChatGPT login cannot be a fallback model",
      unavailable: "Not available",
      missing: "This connection no longer exists",
    },
  },
  member: {
    label: "Follows the lead",
    sub: "A temporary team member works with its lead's thinking level, fast mode, loop protection and fallback models.",
  },
  search: {
    thinking: "Thinking level",
    fast: "Fast mode",
    effort: "Reasoning effort",
    loop: "Loop protection",
    fallback: "Fallback models",
    failover: "Failover",
    backup: "Backup model",
  },
};
