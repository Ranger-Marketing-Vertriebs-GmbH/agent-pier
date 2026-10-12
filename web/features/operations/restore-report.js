import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

/** One entry of a restore report's `credentialsNeedingLogin`, as the owner reads it. */
export function needsLoginLabel(entry) {
  if (typeof entry === "string" && entry.startsWith("mcp:"))
    return copy.needsMcpServerValues(entry.slice(4));
  return entry;
}
