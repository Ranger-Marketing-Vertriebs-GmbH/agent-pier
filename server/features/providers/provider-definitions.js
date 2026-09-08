import { problem } from "../../lib/storage.js";

export const PROVIDERS = Object.freeze({
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    tools: ["codex", "claude", "opencode"],
    catalogUrl: "https://openrouter.ai/api/v1/models",
  },
  zai: {
    id: "zai",
    name: "Z.ai API",
    tools: ["codex", "claude", "opencode"],
    catalogUrl: "https://models.dev/api.json",
  },
  "zai-coding-plan": {
    id: "zai-coding-plan",
    name: "Z.ai Coding Plan",
    tools: ["codex", "claude", "opencode"],
    catalogUrl: "https://models.dev/api.json",
  },
});

export function providerDefinition(id) {
  if (typeof id !== "string" || !Object.hasOwn(PROVIDERS, id))
    throw problem("Unknown provider.");
  return PROVIDERS[id];
}

export function validModelId(id) {
  return (
    typeof id === "string" &&
    id.length <= 200 &&
    /^(?:[a-zA-Z0-9~][a-zA-Z0-9._:+~-]*\/)*[a-zA-Z0-9~][a-zA-Z0-9._:+~-]*$/.test(id) &&
    !id
      .split("/")
      .some((part) => ["constructor", "prototype", "__proto__"].includes(part))
  );
}

export function validateProviderSelection(value, tool, catalog) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["id", "modelId", "responsesAccess"].includes(key))
  )
    throw problem("Invalid provider selection. Model limits are resolved by the server.");
  const definition = providerDefinition(value.id);
  if (!definition.tools.includes(tool))
    throw problem("This provider does not support the selected CLI.");
  catalog.get(value.id, value.modelId, { tool });
  const requiresResponses = tool === "codex" && value.id !== "openrouter";
  if (requiresResponses && value.responsesAccess !== true)
    throw problem(
      "Z.ai with Codex requires an account with Responses API access. Chat-only accounts are not supported.",
    );
  if (!requiresResponses && value.responsesAccess !== undefined)
    throw problem("Responses access applies only to Z.ai with Codex.");
  return {
    id: value.id,
    modelId: value.modelId,
    ...(requiresResponses ? { responsesAccess: true } : {}),
  };
}
