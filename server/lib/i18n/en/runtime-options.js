// Refusals of an agent's runtime options (runtimes/runtime-options.js) and of Hermes's
// Mixture of Agents (runtimes/hermes/hermes-options.js) and of OpenClaw's memory wiki
// (runtimes/openclaw/openclaw-options.js).
export const runtimeOptions = Object.freeze({
  optionsInvalid: "These runtime options are not valid.",
  optionsUnknownRuntime: (runtime) =>
    `The runtime “${runtime}” is not available in this AgentPier, so it has no options here.`,
  optionsOtherRuntime: (runtime) =>
    `This agent does not run on “${runtime}”, so that runtime's options cannot be set for it.`,
  optionsUnknownKey: (key) => `The agent's runtime has no option “${key}”.`,
  mixtureTooMany: (max) => `Mixture of Agents takes at most ${max} advisor models.`,
  mixtureAdvisorTwice: "Each advisor must be a different model.",
  mixtureAdvisorKind:
    "Only an OpenAI-compatible endpoint or OpenRouter can be an advisor model. ChatGPT logins and other protocols cannot be advisors yet.",
  mixtureAdvisorKeyHeader:
    "This endpoint takes its key in a header of its own. An advisor model needs an endpoint that takes a bearer key.",
  mixtureAdvisorUnavailable:
    "This advisor's model connection or model is not available. Check it under Connections › Model access.",
  mixtureModelKind:
    "Mixture of Agents needs the agent's own model on an OpenAI-compatible endpoint or OpenRouter with a bearer key: it acts on the advice.",
  memoryWikiShared:
    "An agent shared with users cannot keep a memory wiki. Only your own agents can.",
  memoryWikiUserAgent:
    "A user's own agent cannot keep a memory wiki. Only your own agents can.",
  memoryWikiTaskMember:
    "A temporary team member cannot keep a memory wiki. Only your own agents can.",
  modelOptionsTaskMember:
    "A temporary team member works with its lead's thinking level and fast mode. Set them on the lead.",
  memoryWikiNotLoaded:
    "The memory wiki is available after the pending restart of the agent service.",
  runtimeOptionsRestartRequired:
    "Switching on the first memory wiki restarts the agents' Gateway; confirm the restart.",
  memoryWikiChannelBot:
    "An agent whose own Telegram bot serves other people cannot keep a memory wiki: their messages would write lasting pages.",
});
