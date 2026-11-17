// Mixture of Agents of a Hermes agent (Capabilities tab, ADR 0007 step 7a): its
// advisor models, the runtime's own surface (web/features/assistants/runtimes/hermes/).
export const assistantMixtureCopy = {
  title: "Mixture of Agents",
  subtitle: "Advisor models",
  hint: "Hermes asks up to three advisor models once per message and gives their answers to the agent's own model, which then acts alone.",
  description:
    "Before each of your messages, every advisor receives the chat's text (not the agent's tools or instructions) and answers once. Their providers therefore receive your conversation, and every advisor adds one model call per message. The agent's own model still acts and pays for the run. Routines of this agent use the advisors too. If an advisor's provider cannot serve a request (no answer within two minutes, a rate limit, used-up credit, a connection error), Hermes answers with the agent's own model instead.",
  off: "Off: the agent's own model works alone.",
  advisor: (number) => `Advisor ${number}`,
  chooseConnection: "Choose a connection",
  model: "Model",
  chooseModel: "Choose a model",
  modelId: "Model ID",
  add: "Add an advisor model",
  remove: (number) => `Remove advisor ${number}`,
  most: (max) => `At most ${max} advisor models.`,
  incomplete: "Choose a connection and a model.",
  incompleteSave:
    "Choose a connection and a model for every advisor, or remove the advisor, to save.",
  leftOut: (reason) => `Left out until it is available again: ${reason}`,
  reasons: {
    kind: "ChatGPT logins and other protocols cannot be advisors yet",
    keyHeader: "This endpoint takes its key in a header of its own",
    unavailable: "Not available",
    missing: "This connection no longer exists",
  },
  aggregator:
    "Needs the agent's own model on an OpenAI-compatible endpoint or OpenRouter with a bearer key: it acts on the advice. Change the model under Identity first.",
  search: {
    moa: "MoA",
    several: "several models",
  },
};
