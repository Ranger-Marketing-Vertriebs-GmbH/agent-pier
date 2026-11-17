import { assistantProblem } from "../../assistant-validation.js";
import { validModelId } from "../../../providers/provider-definitions.js";

// Hermes's own per-agent options (`runtimeOptions.hermes`, ADR 0007 decision 9):
// `mixture: { advisors: [{ connectionId, modelId }] }`, Mixture of Agents with one to
// three advisor models (hermes-config/mixture.js compiles it). No advisors is off,
// stored as nothing.

/** At most this many advisors per agent (the owner's choice, 2026-11-17). */
export const maxAdvisors = 3;
// The connection kinds an advisor may be: an OpenAI-compatible endpoint or OpenRouter
// (assistant-models.js). A ChatGPT login and native protocols cannot advise yet.
const advisorKinds = new Set(["endpoint", "openrouter"]);
const optionKeys = new Set(["mixture"]);
const mixtureKeys = new Set(["advisors"]);
const advisorKeys = new Set(["connectionId", "modelId"]);
const isRecord = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const sameAdvisor = (a) => (b) =>
  a.connectionId === b.connectionId && a.modelId === b.modelId;

// One stored advisor as it is written: two short texts, the model id as an agent's own.
const wellFormed = (advisor) =>
  isRecord(advisor) &&
  Object.keys(advisor).every((key) => advisorKeys.has(key)) &&
  typeof advisor.connectionId === "string" &&
  advisor.connectionId.length > 0 &&
  advisor.connectionId.length <= 100 &&
  typeof advisor.modelId === "string" &&
  advisor.modelId.length <= 256 &&
  validModelId(advisor.modelId);

/**
 * Why `connection` (an entry of AssistantModels.listCapabilities) cannot serve model
 * `modelId` as part of a mixture, or null: "kind" for a ChatGPT login or a connection
 * of another kind, "keyHeader" for an endpoint that takes its key in a header of its
 * own (Hermes hands a mixture slot its key only as a bearer token,
 * agent/moa_loop.py `_slot_runtime`), "unavailable" for one that cannot serve it now.
 * Shared with the web app's rule (web runtimes/hermes/mixture-rules.js).
 */
export function mixtureProblem(connection, modelId) {
  if (!connection) return "unavailable";
  if (!advisorKinds.has(connection.providerId)) return "kind";
  if (connection.keyHeader) return "keyHeader";
  if (connection.available !== true) return "unavailable";
  if (
    connection.providerId === "endpoint" &&
    !(connection.models || []).some((model) => model.modelId === modelId)
  )
    return "unavailable";
  return null;
}

const refusals = {
  kind: () => assistantProblem("mixtureAdvisorKind", 400),
  keyHeader: () => assistantProblem("mixtureAdvisorKeyHeader", 400),
  unavailable: () => assistantProblem("mixtureAdvisorUnavailable", 409),
};

/**
 * Hermes's options as stored (`value`, any JSON), read tolerantly: unknown keys and
 * malformed advisors are left out, at most `maxAdvisors` kept. `{}` when off.
 */
export function readHermesOptions(value) {
  const advisors = isRecord(value) && isRecord(value.mixture) && value.mixture.advisors;
  if (!Array.isArray(advisors)) return {};
  const kept = [];
  for (const advisor of advisors)
    if (
      wellFormed(advisor) &&
      !kept.some(sameAdvisor(advisor)) &&
      kept.length < maxAdvisors
    )
      kept.push({ connectionId: advisor.connectionId, modelId: advisor.modelId });
  return kept.length ? { mixture: { advisors: kept } } : {};
}

/**
 * Hermes's options of a write (`value`) for `agent` (its stored record), or a
 * translated refusal: an unknown key, a malformed or repeated advisor, more than
 * three, an advisor of another kind or one not available now (an advisor already
 * stored stays although its connection became unavailable: the compile leaves it
 * out), and advisors for an agent whose own model cannot act as their aggregator.
 * `context.models` is AssistantModels. Returns the stored form, `{}` when off.
 */
export function validateHermesOptions(value, { agent, models } = {}) {
  if (!isRecord(value)) throw assistantProblem("optionsInvalid");
  const unknown = Object.keys(value).find((key) => !optionKeys.has(key));
  if (unknown) throw assistantProblem("optionsUnknownKey", 400, unknown);
  if (!("mixture" in value)) return {};
  const { mixture } = value;
  if (!isRecord(mixture)) throw assistantProblem("optionsInvalid");
  const strange = Object.keys(mixture).find((key) => !mixtureKeys.has(key));
  if (strange) throw assistantProblem("optionsUnknownKey", 400, strange);
  const advisors = mixture.advisors ?? [];
  if (!Array.isArray(advisors) || !advisors.every(wellFormed))
    throw assistantProblem("optionsInvalid");
  if (advisors.length > maxAdvisors)
    throw assistantProblem("mixtureTooMany", 400, maxAdvisors);
  if (
    advisors.some((advisor, index) => advisors.findIndex(sameAdvisor(advisor)) !== index)
  )
    throw assistantProblem("mixtureAdvisorTwice");
  if (!advisors.length) return {};
  const listed = models?.listCapabilities?.() || [];
  const find = (id) => listed.find((connection) => connection.id === id);
  // The agent's own model is the aggregator, compiled as a slot like the advisors.
  const own = agent?.model;
  const ownProblem = mixtureProblem(find(own?.connectionId), own?.modelId);
  if (ownProblem === "kind" || ownProblem === "keyHeader")
    throw assistantProblem("mixtureModelKind", 409);
  const stored = readHermesOptions(agent?.runtimeOptions?.hermes).mixture?.advisors || [];
  for (const advisor of advisors) {
    const problem = mixtureProblem(find(advisor.connectionId), advisor.modelId);
    // A stored advisor whose connection went away is kept: the compile leaves it out.
    if (problem === "unavailable" && stored.some(sameAdvisor(advisor))) continue;
    if (problem) throw refusals[problem]();
  }
  return {
    mixture: {
      advisors: advisors.map(({ connectionId, modelId }) => ({ connectionId, modelId })),
    },
  };
}

/** Hermes's options module (runtime-options.js): validate, read and connections. */
export const hermesOptions = Object.freeze({
  validate: validateHermesOptions,
  read: readHermesOptions,
  // The model connections the options name, for the apply to resolve.
  connections: (options) => options.mixture?.advisors || [],
});
