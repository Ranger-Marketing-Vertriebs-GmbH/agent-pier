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
    return url ? new URL(url).origin : "";
  } catch {
    return url;
  }
};

export const originsChanged = (saved, draft) =>
  !!saved &&
  [origin(saved.openaiBaseUrl), origin(saved.anthropicBaseUrl)].sort().join() !==
    [origin(draft.openaiBaseUrl), origin(draft.anthropicBaseUrl)].sort().join();

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
    models: proposal.models,
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
