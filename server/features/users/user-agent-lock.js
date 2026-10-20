import { lockedTools } from "../assistants/native-capabilities.js";
import { isUserAgent } from "./user-access.js";

export { lockedTools };

/**
 * The hard lock on a compiled agent entry, applied last (openclaw-config/agent-entry.js):
 * a user agent's allow list loses every locked tool, its deny list names all of them
 * and it has no exec override. Skills and everything else stay as compiled. Other
 * agents' entries are returned unchanged.
 */
export function lockedEntry(entry, assistant) {
  if (!isUserAgent(assistant)) return entry;
  const { exec: _exec, ...tools } = entry.tools || {};
  return {
    ...entry,
    tools: {
      ...tools,
      allow: (tools.allow || []).filter((tool) => !lockedTools.includes(tool)),
      deny: [...lockedTools],
    },
  };
}

/** Whether a tool call by the agent is one the hard lock refuses. */
export function lockedCall(assistant, toolName) {
  return isUserAgent(assistant) && lockedTools.includes(toolName);
}
