// Pure rules of the fallback models in OpenClaw's "Model behaviour" surface
// (FallbackRows.jsx): which model connections may be a fallback, why one cannot, and
// the options a change stores (`runtimeOptions.openclaw.fallbacks`, server
// runtimes/openclaw/openclaw-options.js, whose fallbackProblem a test keeps equal to
// the one here). No request here.

import { assistantModelOptionsCopy } from "../../../../lib/i18n/messages/assistant-model-options.js";

/** At most this many fallback models per agent. */
export const maxFallbacks = 2;
// A connection whose provider AgentPier compiles itself: OpenRouter or an endpoint.
// A ChatGPT login cannot be one (OpenClaw would choose the account itself).
const kinds = new Set(["endpoint", "openrouter"]);

/**
 * Why `connection` (an entry of the agent model list) cannot be a fallback with
 * model `modelId`, or null: "missing", "kind" or "unavailable". Without a model id
 * only the connection itself is judged.
 */
export function fallbackProblem(connection, modelId) {
  if (!connection) return "missing";
  if (!kinds.has(connection.providerId)) return "kind";
  if (connection.available !== true) return "unavailable";
  if (
    modelId &&
    connection.providerId === "endpoint" &&
    !(connection.models || []).some((model) => model.modelId === modelId)
  )
    return "unavailable";
  return null;
}

/** The fallbacks of the agent's OpenClaw options, in order (`[]` without any). */
export const fallbacksOf = (options) =>
  Array.isArray(options?.fallbacks) ? options.fallbacks : [];

/** The draft's options with `fallbacks`; none stores nothing, the other options stay. */
export const withFallbacks = (options, fallbacks) => {
  const { fallbacks: _old, ...rest } = options || {};
  return fallbacks.length ? { ...rest, fallbacks } : rest;
};

/**
 * Whether a fallback row is the agent's own drafted model (`own`, `{ connectionId,
 * modelId }`): the server refuses it, a fallback must be another model.
 */
export const isOwnModel = (fallback, own) =>
  !!fallback?.connectionId &&
  !!fallback.modelId &&
  fallback.connectionId === own?.connectionId &&
  fallback.modelId === own?.modelId;

/**
 * The connection choices of a fallback row: every connection of `models` that could
 * be a fallback, those that cannot serve now disabled with their reason
 * (`reasonText(problem, connection)`), and the row's own `current` connection once
 * more when it is gone from the list. A ChatGPT login is not listed at all.
 */
export function connectionChoices(models, current, label, reasonText) {
  const choices = models
    .filter(
      (connection) => fallbackProblem(connection) !== "kind" || connection.id === current,
    )
    .map((connection) => {
      const problem = fallbackProblem(connection);
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
 * Why the fallback rows of `options` cannot be saved yet, or null: "incomplete" for
 * a row that lacks its connection or model, "twice" for a model named twice. The
 * server refuses both, so the tab's save waits.
 */
export function fallbacksProblem(options) {
  const fallbacks = fallbacksOf(options);
  if (fallbacks.some((fallback) => !fallback.connectionId || !fallback.modelId))
    return "incomplete";
  const seen = new Set(fallbacks.map((f) => JSON.stringify([f.connectionId, f.modelId])));
  return seen.size === fallbacks.length ? null : "twice";
}

/**
 * Why the options of an agent's draft cannot be saved yet, in the owner's words, or
 * null (the runtime's `optionsProblem`, index.js): the tab keeps its save disabled
 * with that message.
 */
export function fallbackSaveProblem(options) {
  const problem = fallbacksProblem(options);
  if (problem === "incomplete") return assistantModelOptionsCopy.fallback.incompleteSave;
  if (problem === "twice") return assistantModelOptionsCopy.fallback.twiceSave;
  return null;
}
