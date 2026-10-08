import { DEFAULT_ROUTING } from "./endpoint-routes.js";

const adapterFields = (endpoint) => ({
  routing: { ...DEFAULT_ROUTING, ...(endpoint?.routing || {}) },
  adapterCapabilities: structuredClone(endpoint?.adapterCapabilities || {}),
  thinkTagExtraction: endpoint?.thinkTagExtraction === true,
  capabilityProposal: {},
});

export const PRESETS = {
  ollama: {
    openaiBaseUrl: "http://127.0.0.1:11434/v1",
    anthropicBaseUrl: "http://127.0.0.1:11434",
    protocols: { messages: true, responses: true, chatCompletions: true },
  },
  llamacpp: {
    openaiBaseUrl: "http://127.0.0.1:8080/v1",
    anthropicBaseUrl: "http://127.0.0.1:8080",
    protocols: { messages: false, responses: false, chatCompletions: true },
  },
  custom: {
    openaiBaseUrl: "",
    anthropicBaseUrl: "",
    protocols: { messages: false, responses: false, chatCompletions: true },
  },
};

export function initialEndpoint(connection, preset = "ollama") {
  if (connection?.endpoint)
    return {
      ...structuredClone(connection.endpoint),
      anthropicBaseUrl: connection.endpoint.anthropicBaseUrl || "",
      authHeader: connection.endpoint.authHeader || "",
      models: structuredClone(connection.endpoint.models || []).map((model) => ({
        ...model,
        images: model.images ?? null,
      })),
      ...adapterFields(connection.endpoint),
      // A saved (or deliberately cleared) Anthropic URL is never overwritten.
      anthropicAuto: false,
    };
  return {
    preset,
    ...structuredClone(PRESETS[preset]),
    authHeader: "",
    models: [],
    lastTest: null,
    ...adapterFields(null),
  };
}

// A test result only describes the address and key it ran against.
export const withoutTest = (draft) => ({
  ...draft,
  lastTest: null,
  modelsTruncated: false,
  capabilityProposal: {},
});

export const suggestAnthropicUrl = (url) =>
  url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");

// Keeps the Anthropic URL derived from the OpenAI URL until the user edits it.
export const withOpenaiUrl = (draft, value) => ({
  ...draft,
  openaiBaseUrl: value,
  ...(draft.anthropicAuto !== false
    ? { anthropicBaseUrl: suggestAnthropicUrl(value) }
    : {}),
});

const origin = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

// Mirrors the server's endpointOrigins: the sorted set of non-empty origins.
const origins = (endpoint) =>
  [
    ...new Set(
      [endpoint.openaiBaseUrl, endpoint.anthropicBaseUrl]
        .map((url) => (url || "").trim())
        .filter(Boolean)
        .map(origin),
    ),
  ]
    .sort()
    .join();

export const originsChanged = (saved, draft) =>
  !!saved && origins(saved) !== origins(draft);

export const keyReentryRequired = ({ connection, draft, apiKey, removeApiKey }) =>
  Boolean(connection?.hasSecret) &&
  !apiKey.trim() &&
  !removeApiKey &&
  originsChanged(connection.endpoint, draft);

export const MODEL_LIMIT = 200;
const TOKEN_MIN = 1024;
const TOKEN_MAX = 10_000_000;

// Same rule as the server's validModelId.
export const validModelId = (id) =>
  typeof id === "string" &&
  id.length <= 200 &&
  /^(?:[a-zA-Z0-9~][a-zA-Z0-9._:+~-]*\/)*[a-zA-Z0-9~][a-zA-Z0-9._:+~-]*$/.test(id) &&
  !id.split("/").some((part) => ["constructor", "prototype", "__proto__"].includes(part));

const validTokens = (value) =>
  value === null ||
  value === undefined ||
  (Number.isInteger(value) && value >= TOKEN_MIN && value <= TOKEN_MAX);

// Mirrors the server's model rules; returns a message key or null per model.
export function modelProblem(model, models) {
  if (!validModelId(model.modelId)) return "invalidId";
  if (models.filter((item) => item.modelId === model.modelId).length > 1)
    return "duplicate";
  if (!validTokens(model.contextTokens)) return "contextRange";
  if (!validTokens(model.outputTokens)) return "outputRange";
  if (
    model.contextTokens &&
    model.outputTokens &&
    model.outputTokens > model.contextTokens
  )
    return "outputOverContext";
  return null;
}

export const modelsInvalid = (models) =>
  models.length > MODEL_LIMIT || models.some((model) => modelProblem(model, models));

// Same rule as the server: manual models always survive, detected ones are capped.
function mergeModels(previous, proposal) {
  if (!proposal.listed) return { models: previous, truncated: false };
  const byId = new Map(previous.map((model) => [model.modelId, model]));
  const listed = proposal.models.filter((model) => model.source === "detected");
  const listedIds = new Set(listed.map((model) => model.modelId));
  const manual = previous.filter(
    (model) => model.source === "manual" && !listedIds.has(model.modelId),
  );
  const isManual = (model) => byId.get(model.modelId)?.source === "manual";
  let budget = Math.max(0, MODEL_LIMIT - manual.length - listed.filter(isManual).length);
  const kept = listed.filter((model) => isManual(model) || budget-- > 0);
  const detected = kept.map((model) => {
    const old = byId.get(model.modelId);
    return {
      modelId: model.modelId,
      label: old?.label ?? model.label,
      contextTokens: old?.contextEdited ? old.contextTokens : model.contextTokens,
      outputTokens: old?.contextEdited
        ? old.outputTokens
        : (old?.outputTokens ?? model.outputTokens ?? null),
      source: "detected",
      contextEdited: old?.contextEdited === true,
      images: old?.images ?? null,
      ...(model.contextHint ? { contextHint: model.contextHint } : {}),
    };
  });
  return { models: [...detected, ...manual], truncated: kept.length < listed.length };
}

const mergeCapabilities = (current = {}, proposed = {}) =>
  Object.fromEntries(
    [...new Set([...Object.keys(current), ...Object.keys(proposed)])].map((source) => [
      source,
      { ...(current[source] || {}), ...(proposed[source] || {}) },
    ]),
  );

export function applyProposal(draft, proposal, now = new Date().toISOString()) {
  const protocols = Object.fromEntries(
    Object.entries(draft.protocols).map(([name, enabled]) => [
      name,
      proposal.protocols[name] === "ok"
        ? true
        : proposal.protocols[name] === "skipped"
          ? enabled
          : false,
    ]),
  );
  const merged = mergeModels(draft.models, proposal);
  return {
    ...draft,
    protocols,
    models: merged.models,
    modelsTruncated: merged.truncated,
    lastTest: { at: now, protocols: proposal.protocols, reasons: proposal.reasons },
    adapterCapabilities: mergeCapabilities(
      draft.adapterCapabilities,
      proposal.capabilities,
    ),
    capabilityProposal: structuredClone(proposal.capabilities || {}),
  };
}

export const setRoute = (draft, tool, choice) => ({
  ...draft,
  routing: { ...draft.routing, [tool]: choice },
});
export const setCapability = (draft, source, name, value) => ({
  ...draft,
  adapterCapabilities: {
    ...draft.adapterCapabilities,
    [source]: { ...(draft.adapterCapabilities[source] || {}), [name]: value },
  },
});
export const resetCapabilities = (draft, source) => {
  const { [source]: _removed, ...rest } = draft.adapterCapabilities;
  const { [source]: _proposed, ...proposal } = draft.capabilityProposal || {};
  return { ...draft, adapterCapabilities: rest, capabilityProposal: proposal };
};
export const setModelImages = (draft, modelId, images) => ({
  ...draft,
  models: draft.models.map((m) => (m.modelId === modelId ? { ...m, images } : m)),
});

const modelPayload = (model) => ({
  modelId: model.modelId,
  label: model.label,
  contextTokens: model.contextTokens ?? null,
  outputTokens: model.outputTokens ?? null,
  source: model.source,
  contextEdited: model.contextEdited,
  contextHint: model.contextHint,
  images: model.images ?? null,
});

export function endpointPayload(draft) {
  return {
    preset: draft.preset,
    openaiBaseUrl: draft.openaiBaseUrl.trim(),
    anthropicBaseUrl: draft.anthropicBaseUrl.trim() || null,
    protocols: draft.protocols,
    authHeader: draft.authHeader.trim() || null,
    models: draft.models.map(modelPayload),
    lastTest: draft.lastTest,
    routing: draft.routing,
    adapterCapabilities: draft.adapterCapabilities,
    thinkTagExtraction: draft.thinkTagExtraction,
  };
}
