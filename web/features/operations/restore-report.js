import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

/** One entry of a restore report's `credentialsNeedingLogin`, as the owner reads it. */
export function needsLoginLabel(entry) {
  if (typeof entry !== "string") return entry;
  if (entry.startsWith("mcp:")) return copy.needsMcpServerValues(entry.slice(4));
  if (entry.startsWith("mcp-address:"))
    return copy.needsMcpServerAddress(entry.slice("mcp-address:".length));
  return entry;
}
