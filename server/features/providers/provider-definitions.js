import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";
import { endpointModel } from "./endpoint-config.js";

const TOOLS = ["codex", "claude", "opencode"];
const ZAI_ENDPOINTS = {
  messages: "https://api.z.ai/api/anthropic",
  responses: "https://api.z.ai/api/v1",
};
const ZAI_KEY_ENV = { codex: "ZAI_API_KEY", opencode: "ZHIPU_API_KEY" };
export const PROVIDERS = Object.freeze({
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    kind: "catalog",
    tools: TOOLS,
    keyRequired: true,
    responsesGate: false,
    catalogUrl: "https://openrouter.ai/api/v1/models",
    codexName: "OpenRouter",
    endpoints: {
      messages: "https://openrouter.ai/api",
      responses: "https://openrouter.ai/api/v1",
    },
    keyEnv: { codex: "OPENROUTER_API_KEY", opencode: "OPENROUTER_API_KEY" },
  },
  zai: {
    id: "zai",
    name: "Z.ai API",
    kind: "catalog",
    tools: TOOLS,
    keyRequired: true,
    responsesGate: true,
    catalogUrl: "https://models.dev/api.json",
    codexName: "Z.ai",
    endpoints: ZAI_ENDPOINTS,
    keyEnv: ZAI_KEY_ENV,
  },
  "zai-coding-plan": {
    id: "zai-coding-plan",
    name: "Z.ai Coding Plan",
    kind: "catalog",
    tools: TOOLS,
    keyRequired: true,
    responsesGate: true,
    catalogUrl: "https://models.dev/api.json",
    codexName: "Z.ai",
    endpoints: ZAI_ENDPOINTS,
    keyEnv: ZAI_KEY_ENV,
  },
  endpoint: {
    id: "endpoint",
    name: "Custom endpoint",
    kind: "endpoint",
    tools: TOOLS,
    keyRequired: false,
    responsesGate: false,
  },
});
export const CATALOG_PROVIDERS = Object.freeze(
  Object.fromEntries(
    Object.entries(PROVIDERS).filter(([, value]) => value.kind === "catalog"),
  ),
);
export const TOOL_PROTOCOL = Object.freeze({
  claude: "messages",
  codex: "responses",
  opencode: "chatCompletions",
});

export function providerDefinition(id) {
  if (typeof id !== "string" || !Object.hasOwn(PROVIDERS, id))
    throw problem(serverMessages.providers.unknownProvider);
  return PROVIDERS[id];
}

export function catalogProviderDefinition(id) {
  const definition = providerDefinition(id);
  if (definition.kind !== "catalog")
    throw problem(serverMessages.providers.unknownProvider);
  return definition;
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

export function validateProviderSelection(value, tool, catalog, { endpoint } = {}) {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["id", "modelId", "responsesAccess"].includes(key))
  )
    throw problem(serverMessages.providers.invalidProviderSelection);
  const definition = providerDefinition(value.id);
  if (!definition.tools.includes(tool))
    throw problem(serverMessages.providers.providerToolUnsupported);
  if (definition.kind === "endpoint") {
    if (!endpoint || value.responsesAccess !== undefined)
      throw problem(serverMessages.providers.invalidProviderSelection);
    if (!validModelId(value.modelId))
      throw problem(serverMessages.providers.invalidModelId);
    endpointModel(endpoint, value.modelId, tool);
    return { id: value.id, modelId: value.modelId };
  }
  catalog.get(value.id, value.modelId, { tool });
  const requiresResponses = tool === "codex" && definition.responsesGate;
  if (requiresResponses && value.responsesAccess !== true)
    throw problem(serverMessages.providers.zaiCodexRequiresResponses);
  if (!requiresResponses && value.responsesAccess !== undefined)
    throw problem(serverMessages.providers.responsesAccessZaiCodexOnly);
  return {
    id: value.id,
    modelId: value.modelId,
    ...(requiresResponses ? { responsesAccess: true } : {}),
  };
}
