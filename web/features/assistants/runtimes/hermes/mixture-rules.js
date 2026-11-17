// Pure rules of Hermes's Mixture of Agents group (MixtureSurface.jsx): which model
// connections may advise, why one cannot, and the options a change stores
// (`runtimeOptions.hermes`, server runtimes/hermes/hermes-options.js, whose
// mixtureProblem a test keeps equal to advisorProblem here). No request here.

/** At most this many advisors per agent. */
export const maxAdvisors = 3;
// An OpenAI-compatible endpoint or OpenRouter (server assistant-models.js).
const kinds = new Set(["endpoint", "openrouter"]);

/**
 * Why `connection` (an entry of the agent model list) cannot advise with model
 * `modelId`, or null: "missing", "kind", "keyHeader" or "unavailable". Without a
 * model id only the connection itself is judged.
 */
export function advisorProblem(connection, modelId) {
  if (!connection) return "missing";
  if (!kinds.has(connection.providerId)) return "kind";
  if (connection.keyHeader) return "keyHeader";
  if (connection.available !== true) return "unavailable";
  if (
    modelId &&
    connection.providerId === "endpoint" &&
    !(connection.models || []).some((model) => model.modelId === modelId)
  )
    return "unavailable";
  return null;
}

/** The advisors of the agent's Hermes options (`{}` when off). */
export const advisorsOf = (options) =>
  Array.isArray(options?.mixture?.advisors) ? options.mixture.advisors : [];

/** The options that store `advisors`; none is `{}`, Mixture of Agents off. */
export const withAdvisors = (advisors) =>
  advisors.length ? { mixture: { advisors } } : {};

/**
 * Whether the agent's own model can act on the advice: the aggregator is a Mixture
 * slot too, so it needs a kind and key an advisor needs. An unknown connection (the
 * list not read yet) does not count against it.
 */
export function aggregatorReady(models, assistant) {
  const own = models.find((m) => m.id === assistant?.model?.connectionId);
  const problem = own ? advisorProblem(own) : null;
  return problem !== "kind" && problem !== "keyHeader";
}

/**
 * The connection choices of an advisor row: every connection of `models`, those that
 * cannot advise disabled with their reason (`reasonText(problem, connection)`), and
 * the row's own `current` connection once more when it is gone from the list.
 */
export function connectionChoices(models, current, label, reasonText) {
  const choices = models.map((connection) => {
    const problem = advisorProblem(connection);
    return {
      value: connection.id,
      label: problem
        ? `${label(connection)} · ${reasonText(problem, connection)}`
        : label(connection),
      disabled: Boolean(problem),
    };
  });
  if (current && !models.some((m) => m.id === current))
    choices.push({
      value: current,
      label: `${current} · ${reasonText("missing")}`,
      disabled: true,
    });
  return choices;
}

/** The model ids an endpoint connection lists, or null for a free one (OpenRouter). */
export const listedModels = (connection) =>
  connection?.providerId === "endpoint" ? connection.models || [] : null;

/**
 * Whether an advisor row of `options` still lacks its connection or model: the tab
 * cannot save it (the server refuses an advisor without either), so its save waits.
 */
export const incompleteAdvisors = (options) =>
  advisorsOf(options).some((advisor) => !advisor.connectionId || !advisor.modelId);
