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

// OpenRouter quotes USD per token as strings; "-1" marks dynamic pricing.
function perMillion(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const perToken = Number(value);
  if (!Number.isFinite(perToken) || perToken < 0) return null;
  const scaled = Math.round(perToken * 1e12) / 1e6;
  return Number.isFinite(scaled) ? scaled : null;
}

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
        pricing: {
          inputPerMTok: perMillion(model.pricing?.prompt),
          outputPerMTok: perMillion(model.pricing?.completion),
        },
        tools: ["codex", "claude", "opencode"],
        source: "https://openrouter.ai/api/v1/models",
        fetchedAt: timestamp(fetchedAt),
        capabilities: {
          toolCalling: true,
          reasoning: model.supported_parameters.includes("reasoning"),
          // Agents send images inline only to models that take them.
          imageInput: model.architecture.input_modalities.includes("image"),
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
