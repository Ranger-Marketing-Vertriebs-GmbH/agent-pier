import { validModelId } from "./provider-definitions.js";

export const tokenLimit = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 10000000 ? value : null;
const timestamp = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : new Date().toISOString();
const label = (value, fallback) =>
  typeof value === "string" && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value)
    ? value
    : fallback;

function unique(models) {
  return [...new Map(models.map((model) => [model.modelId, model])).values()].sort(
    (a, b) => a.modelId.localeCompare(b.modelId),
  );
}

export function normalizeOpenRouter(payload, fetchedAt) {
  if (!Array.isArray(payload?.data)) throw new Error("Invalid OpenRouter catalog.");
  return unique(
    payload.data
      .slice(0, 20000)
      .filter(
        (model) =>
          validModelId(model?.id) &&
          model.architecture?.input_modalities?.includes("text") &&
          model.architecture?.output_modalities?.includes("text") &&
          model.supported_parameters?.includes("tools"),
      )
      .map((model) => ({
        providerId: "openrouter",
        modelId: model.id,
        label: label(model.name, model.id),
        contextTokens: tokenLimit(model.context_length),
        routingContextTokens: tokenLimit(model.top_provider?.context_length),
        outputTokens: tokenLimit(model.top_provider?.max_completion_tokens),
        tools: ["codex", "claude", "opencode"],
        source: "https://openrouter.ai/api/v1/models",
        fetchedAt: timestamp(fetchedAt),
        capabilities: {
          toolCalling: true,
          reasoning: model.supported_parameters.includes("reasoning"),
        },
      })),
  );
}

export function normalizeZai(payload, providerId, fetchedAt) {
  const models = payload?.[providerId]?.models;
  if (!models || typeof models !== "object" || Array.isArray(models))
    throw new Error("Invalid Z.ai catalog.");
  return unique(
    Object.values(models)
      .slice(0, 20000)
      .filter(
        (model) =>
          validModelId(model?.id) &&
          model.tool_call === true &&
          model.modalities?.input?.includes("text") &&
          model.modalities?.output?.includes("text"),
      )
      .map((model) => ({
        providerId,
        modelId: model.id,
        label: label(model.name, model.id),
        contextTokens: tokenLimit(model.limit?.context),
        routingContextTokens: null,
        outputTokens: tokenLimit(model.limit?.output),
        tools:
          model.id === "glm-5.3"
            ? ["codex", "claude", "opencode"]
            : ["claude", "opencode"],
        source: "https://models.dev/api.json",
        fetchedAt: timestamp(fetchedAt),
        capabilities: { toolCalling: true, reasoning: model.reasoning === true },
        ...(model.id === "glm-5.3"
          ? {
              codexContextTokens: 1048576,
              codexContextSource: "https://docs.z.ai/devpack/tool/codex",
            }
          : {}),
      })),
  );
}
