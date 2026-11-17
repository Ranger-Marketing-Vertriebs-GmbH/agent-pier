// Refusals of an agent's runtime options (runtimes/runtime-options.js) and of Hermes's
// Mixture of Agents (runtimes/hermes/hermes-options.js).
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
});
