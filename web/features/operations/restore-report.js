import { operationsCopy as copy } from "../../lib/i18n/messages/operations.js";

/** One entry of a restore report's `credentialsNeedingLogin`, as the owner reads it. */
export function needsLoginLabel(entry) {
  if (typeof entry !== "string") return entry;
  if (entry.startsWith("user:")) return copy.needsUserPassword(entry.slice(5));
  if (entry.startsWith("mcp:")) return copy.needsMcpServerValues(entry.slice(4));
  if (entry.startsWith("mcp-address:"))
    return copy.needsMcpServerAddress(entry.slice("mcp-address:".length));
  return entry;
}

/** A restore report value as the owner reads it: lists joined, yes or no for flags. */
export function reportValue(key, value) {
  if (Array.isArray(value))
    return value
      .map((item) => (key === "credentialsNeedingLogin" ? needsLoginLabel(item) : item))
      .join(", ");
  if (typeof value === "boolean") return value ? copy.yes : copy.no;
  return String(value);
}
