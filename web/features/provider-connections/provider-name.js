import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import { LISTED_PRESETS } from "./endpoint-draft.js";

/**
 * The provider a connection shows: an endpoint created from a listed preset (Ollama,
 * llama.cpp, Azure OpenAI) is named after it, any other endpoint "Custom endpoint".
 */
export function connectionProviderName(connection) {
  const preset = connection?.endpoint?.preset;
  if (connection?.providerId === "endpoint" && LISTED_PRESETS.includes(preset))
    return copy.endpoint.presets[preset];
  return copy.providerNames[connection?.providerId] || connection?.providerId || "";
}
