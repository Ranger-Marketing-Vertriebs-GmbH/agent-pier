import { formatMessageTime } from "../../lib/i18n/index.js";
import { connectionsAreaCopy as copy } from "../../lib/i18n/messages/connections-area.js";

/** Whether no CLI and no agent uses the server: "Check status" has nothing to read. */
export const mcpUnused = (server) =>
  !server.clis?.length && !server.users?.agents?.length && !server.users?.clis?.length;

/**
 * The line under "Check status" once it ran (`result`: `{ failed, at }`): when it was
 * checked, that an unused server has no status to read, or that the check failed.
 */
export function mcpCheckText(server, result) {
  if (result.failed) return copy.checkFailed;
  const time = formatMessageTime(result.at);
  return mcpUnused(server) ? copy.checkedUnused(time) : copy.checkedAt(time);
}
