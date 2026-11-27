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
  member: {
    label: "Follows the lead",
    sub: "A temporary team member works with its lead's thinking level, fast mode and loop protection.",
  },
  search: {
    thinking: "Thinking level",
    fast: "Fast mode",
    effort: "Reasoning effort",
    loop: "Loop protection",
  },
};
