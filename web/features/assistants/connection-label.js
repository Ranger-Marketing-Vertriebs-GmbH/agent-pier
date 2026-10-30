import { connectionCopy } from "../../lib/i18n/messages/connections.js";
import { connectionProviderName } from "../provider-connections/provider-name.js";

/** "ChatGPT · name" for an agent connection; the provider is not repeated when the name already is it. */
export function connectionLabel(connection) {
  const name = String(connection?.name || "").trim();
  const provider = connectionCopy.providerNames[connection?.providerId]
    ? connectionProviderName(connection)
    : "";
  if (!provider) return name;
  if (!name) return provider;
  if (name.toLowerCase() === provider.toLowerCase()) return provider;
  return `${provider} · ${name}`;
}
