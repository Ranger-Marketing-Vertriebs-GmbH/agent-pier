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
      models: structuredClone(connection.endpoint.models || []),
    };
  return {
    preset,
    ...structuredClone(PRESETS[preset]),
    authHeader: "",
    models: [],
    lastTest: null,
  };
}

export const suggestAnthropicUrl = (url) =>
  url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");

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

function mergeModels(previous, proposal) {
  if (!proposal.listed) return previous;
  const byId = new Map(previous.map((model) => [model.modelId, model]));
  const detected = proposal.models
    .filter((model) => model.source === "detected")
    .map((model) => {
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
        ...(model.contextHint ? { contextHint: model.contextHint } : {}),
      };
    });
  const ids = new Set(detected.map((model) => model.modelId));
  return [
    ...detected,
    ...previous.filter((model) => model.source === "manual" && !ids.has(model.modelId)),
  ];
}

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
  return {
    ...draft,
    protocols,
    models: mergeModels(draft.models, proposal),
    lastTest: { at: now, protocols: proposal.protocols, reasons: proposal.reasons },
  };
}

const modelPayload = (model) => ({
  modelId: model.modelId,
  label: model.label,
  contextTokens: model.contextTokens ?? null,
  outputTokens: model.outputTokens ?? null,
  source: model.source,
  contextEdited: model.contextEdited,
  contextHint: model.contextHint,
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
  };
}
