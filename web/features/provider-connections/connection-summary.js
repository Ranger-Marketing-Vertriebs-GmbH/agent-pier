import { connectionCopy as copy } from "../../lib/i18n/messages/connections.js";
import { connectionProviderName } from "./provider-name.js";

function endpointHost(connection) {
  const url = connection.endpoint?.openaiBaseUrl || connection.endpoint?.anthropicBaseUrl;
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Provider · endpoint host · key state, as the connection list shows it. */
export function connectionSummary(connection) {
  return [
    connectionProviderName(connection),
    endpointHost(connection),
    connection.hasSecret
      ? copy.keySaved
      : connection.launchable
        ? copy.keyNotRequired
        : copy.keyMissing,
  ].filter(Boolean);
}
