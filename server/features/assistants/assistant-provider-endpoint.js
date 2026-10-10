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
  // Connections validate this catalog. The native runtime uses Chat Completions
  // directly, independently of the connection's per-CLI routing choices.
  const models = endpoint.models.flatMap(
    ({ modelId, label, contextTokens, outputTokens }) =>
      // OpenClaw 2026.9.8 rejects model context windows below 4,000 tokens.
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
  return {
    available: models.length > 0,
    ...(models.length ? {} : { reason: "modelConfiguration" }),
    models,
  };
}
// The runtime calls Chat Completions directly, so only the owner's explicit Chat
// Completions adapter choices with a native equivalent apply; routing, think-tag
// extraction and other protocols' options belong to the CLI adapter path.
function nativeCompat(endpoint) {
  const chat = endpoint.adapterCapabilities?.chatCompletions || {};
  return {
    ...(chat.maxTokensField ? { maxTokensField: chat.maxTokensField } : {}),
    ...(typeof chat.streamUsage === "boolean"
      ? { supportsUsageInStreaming: chat.streamUsage }
      : {}),
  };
}
export function assistantEndpointProvider(connection, modelId, apiKey) {
  const capability = endpointCapability(connection);
  const model = capability.models.find((model) => model.modelId === modelId);
  if (!capability.available || !model) throw assistantProblem("provider");
  const { openaiBaseUrl: baseUrl, authHeader } = connection.endpoint;
  if (connection.hasSecret && !apiKey) throw assistantProblem("provider");
  const images = connection.endpoint.models.find((m) => m.modelId === modelId)?.images;
  const compat = nativeCompat(connection.endpoint);
  return {
    baseUrl,
    api: "openai-completions",
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
        ...(Object.keys(compat).length ? { compat } : {}),
      },
    ],
  };
}
