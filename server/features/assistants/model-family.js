/**
 * The maker of a model, so a model change can tell a switch within one family
 * (no fresh chat needed) from a switch to another maker. ChatGPT accounts run OpenAI
 * models; OpenRouter names the maker before the slash of the model id; an endpoint
 * counts only a known maker prefix and otherwise forms a family per connection.
 */
const ENDPOINT_PREFIXES = new Set([
  "openai",
  "anthropic",
  "x-ai",
  "google",
  "deepseek",
  "mistralai",
  "qwen",
  "z-ai",
  "moonshotai",
  "meta-llama",
]);

const prefixOf = (modelId) => {
  const at = typeof modelId === "string" ? modelId.indexOf("/") : -1;
  return at > 0 ? modelId.slice(0, at) : null;
};

/** `connections.get(id).providerId` names the provider; an unreadable one is unknown. */
export function modelFamily({ connectionId, modelId } = {}, connections) {
  if (typeof connectionId === "string" && connectionId.startsWith("openclaw:"))
    return "openai";
  let providerId;
  try {
    providerId = connections.get(connectionId)?.providerId;
  } catch {
    /* An unknown connection is a family of its own. */
  }
  const prefix = prefixOf(modelId);
  if (providerId === "openrouter" && prefix) return prefix;
  if (providerId === "endpoint" && prefix && ENDPOINT_PREFIXES.has(prefix)) return prefix;
  return `unknown:${connectionId}`;
}

export const familyChanged = (from, to, connections) =>
  modelFamily(from, connections) !== modelFamily(to, connections);
