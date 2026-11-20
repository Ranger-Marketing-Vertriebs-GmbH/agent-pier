import net from "node:net";
import { classifyAddress } from "../providers/endpoint-address.js";
import { fallbackOutputTokens } from "../providers/endpoint-config.js";
import { assistantProblem } from "./assistant-validation.js";

// Match the pinned runtime's synthetic local-auth boundary. Public keyless URLs
// cannot be made usable by inventing credentials or falling back to another account.
function localAuthentication(baseUrl) {
  const hostname = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "");
  return (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    ["host.docker.internal", "docker.orb.internal", "host.orb.internal"].includes(
      hostname,
    ) ||
    classifyAddress(hostname) === "loopback" ||
    (net.isIPv4(hostname) && classifyAddress(hostname) === "private")
  );
}
export function endpointCapability(connection) {
  const { endpoint, hasSecret } = connection;
  if (!endpoint?.protocols.chatCompletions)
    return { available: false, reason: "unsupportedProtocol", models: [] };
  if (
    hasSecret &&
    endpoint.authHeader &&
    !["api-key", "authorization"].includes(endpoint.authHeader.toLowerCase())
  )
    return { available: false, reason: "unsupportedAuthentication", models: [] };
  if (!hasSecret && !localAuthentication(endpoint.openaiBaseUrl))
    return { available: false, reason: "credentialsRequired", models: [] };
  // Connections validate this catalog. The native runtime picks its own protocol
  // (nativeApi), independently of the connection's per-CLI routing choices.
  const models = endpoint.models.flatMap(
    ({ modelId, label, contextTokens, outputTokens }) =>
      // OpenClaw 2026.10.3 rejects model context windows below 4,000 tokens.
      contextTokens >= 4000
        ? [
            {
              modelId,
              label,
              contextTokens,
              outputTokens: fallbackOutputTokens(contextTokens, outputTokens),
            },
          ]
        : [],
  );
  // The models the owner still has to give a context size, so the agent wizard can
  // link to their rows (Azure lists no context for deployments).
  const contextMissing = endpoint.models
    .filter(({ contextTokens }) => !(contextTokens >= 4000))
    .slice(0, 20)
    .map(({ modelId }) => modelId);
  return {
    available: models.length > 0,
    ...(models.length ? {} : { reason: "modelConfiguration" }),
    ...(contextMissing.length ? { contextMissing } : {}),
    // A key sent in a header of its own instead of as a bearer token.
    ...(hasSecret && endpoint.authHeader ? { keyHeader: true } : {}),
    models,
  };
}
/**
 * The pinned runtime's request adapter for an agent on this connection. A connection
 * that offers Responses and sends a key runs on Responses: Azure reasoning deployments
 * refuse function tools together with `reasoning_effort` on Chat Completions and point
 * to Responses, which carries both. Chat Completions stays the fallback, and the only
 * choice without a key: the runtime's synthetic local key covers keyless local
 * `openai-completions` providers only (model-auth-provider-config).
 */
function nativeApi(endpoint, apiKey) {
  return apiKey && endpoint.protocols?.responses === true
    ? "openai-responses"
    : "openai-completions";
}
// The owner's explicit adapter choices (or the connection test's proposals) for the
// protocol the runtime calls, where it has a native equivalent; routing, think-tag
// extraction and other protocols' options belong to the CLI adapter path.
function nativeCompat(endpoint, api) {
  const options = endpoint.adapterCapabilities || {};
  if (api === "openai-responses") {
    // Responses always sends `max_output_tokens`; no token field to choose.
    const responses = options.responses || {};
    return responses.promptCacheKey === true ? { supportsPromptCacheKey: true } : {};
  }
  const chat = options.chatCompletions || {};
  return {
    ...(chat.maxTokensField ? { maxTokensField: chat.maxTokensField } : {}),
    ...(typeof chat.streamUsage === "boolean"
      ? { supportsUsageInStreaming: chat.streamUsage }
      : {}),
    ...(chat.reasoningEffort === false ? { supportsReasoningEffort: false } : {}),
  };
}
// The runtime's Responses adapter sends `reasoning` only to a reasoning model.
const refusesReasoning = (endpoint, api) =>
  api === "openai-responses" &&
  endpoint.adapterCapabilities?.responses?.reasoningEffort === false;
export function assistantEndpointProvider(connection, modelId, apiKey) {
  const capability = endpointCapability(connection);
  const model = capability.models.find((model) => model.modelId === modelId);
  if (!capability.available || !model) throw assistantProblem("provider");
  const { openaiBaseUrl: baseUrl, authHeader } = connection.endpoint;
  if (connection.hasSecret && !apiKey) throw assistantProblem("provider");
  const images = connection.endpoint.models.find((m) => m.modelId === modelId)?.images;
  const api = nativeApi(connection.endpoint, apiKey);
  const compat = nativeCompat(connection.endpoint, api);
  return {
    baseUrl,
    api,
    ...(apiKey ? { apiKey } : {}),
    // request.auth alone leaves the SDK's Bearer credential intact. An empty
    // Authorization override suppresses that credential; the pinned SDK accepts
    // this only with api-key (or an explicitly selected raw Authorization header).
    ...(apiKey && authHeader
      ? {
          authHeader: false,
          headers: { authorization: "", [authHeader.toLowerCase()]: apiKey },
        }
      : {}),
    models: [
      {
        id: model.modelId,
        name: model.label,
        contextWindow: model.contextTokens,
        maxTokens: model.outputTokens,
        // The runtime treats a missing input list as text-only.
        ...(images === true ? { input: ["text", "image"] } : {}),
        ...(refusesReasoning(connection.endpoint, api) ? { reasoning: false } : {}),
        ...(Object.keys(compat).length ? { compat } : {}),
      },
    ],
  };
}
