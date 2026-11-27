// How an OpenClaw agent's model works (the Identity tab, below the model): the
// runtime's own surface (web/features/assistants/runtimes/openclaw/).
export const assistantModelOptionsCopy = {
  title: "Thinking and speed",
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
  member: {
    label: "Follows the lead",
    sub: "A temporary team member works with its lead's thinking level and fast mode.",
  },
  search: {
    thinking: "Thinking level",
    fast: "Fast mode",
    effort: "Reasoning effort",
  },
};
