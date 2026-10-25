import { lockedTools } from "../assistants/native-capabilities.js";
import { assistantProblem } from "../assistants/assistant-validation.js";
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

/** 409 USER_AGENT_LOCKED: a capability the hard lock keeps off for user agents. */
export const userAgentLocked = () =>
  Object.assign(assistantProblem("userAgentLocked", 409), { code: "USER_AGENT_LOCKED" });

/** Refuses any change that would give a user agent a locked capability. */
export function refuseUserAgent(agent) {
  if (isUserAgent(agent)) throw userAgentLocked();
}

/** A settings patch: a user agent keeps shell "off" and no visible browser window. */
export function refuseLockedSettings(agent, patch = {}) {
  if (!isUserAgent(agent)) return;
  if (("shell" in patch && patch.shell !== "off") || patch.browserVisible === true)
    throw userAgentLocked();
}

const filled = (value) => Array.isArray(value) && value.length > 0;
/**
 * An access policy (assistant-access.js): a user agent holds no coding grants, no
 * pipelines, no SSH hosts, no GitHub access, no secrets and no project memory
 * rights. Folders (projectFiles) stay the owner's choice.
 */
export function refuseLockedAccess(agent, input = {}) {
  if (!isUserAgent(agent)) return;
  if (
    filled(input.projectIds) ||
    filled(input.pipelineIds) ||
    filled(input.sshAccesses) ||
    filled(input.secretIds) ||
    (input.github !== undefined && input.github !== null) ||
    input.memoryWrite === true ||
    input.autonomous === true ||
    input.publish === true
  )
    throw userAgentLocked();
}
