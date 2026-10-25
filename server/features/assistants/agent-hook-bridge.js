import { assistantProblem } from "./assistant-validation.js";
import { runSession } from "./agent-hook-runs.js";
import { ownMemoryTarget } from "./lead-request-writes.js";
import { personalCapabilities, shellTools } from "./native-capabilities.js";
import { isShared } from "../users/user-access.js";

/**
 * A hook run in the tool bridge (team-bridge.js). A hook run is an OpenClaw cron run
 * of a one-shot job (agent-hook-runs.js); its origin is resolved live on every call
 * through AgentHooks.runOrigin and holds only while its event runs. The run's
 * session keeps being a hook session after the event settled (an exec completion
 * turn, OpenClaw 2026.10.7): it then gets no bridge tools, no writes and no shell.
 */
// What a hook run may call through the bridge: project folders and coding
// (agent-hook-workspace.js) and SSH on its chosen hosts.
export const hookActions = new Set(["workspace", "ssh"]);

/** The running hook event's origin of this agent's session, or null. */
export function hookRun(bridge, { agentId, sessionKey }) {
  const agent = bridge.agentOf(agentId);
  if (!agent) return null;
  return bridge.assistants.routines?.hooks?.runOrigin(agent, sessionKey) || null;
}

/** The hook event of a cron session whatever its status (also once settled), or null. */
export function hookSession(bridge, { sessionKey }) {
  const events = bridge.assistants.routines?.hooks?.events;
  const match = runSession.exec(typeof sessionKey === "string" ? sessionKey : "");
  return (events && match && events.byJob(match[2])) || null;
}

/** Re-checks a hook ticket on every step (TeamBridge.valid); throws 403. */
export function assertHookRecord(bridge, record) {
  const origin = hookRun(bridge, record);
  if (!hookActions.has(record.action) || origin?.event.id !== record.hook.event.id)
    throw assistantProblem("invalid", 403);
  return record;
}

/**
 * A native write of a hook run: only with the hook's Write memory tick on an agent
 * that holds memory and is not shared, and only to the agent's own MEMORY.md or
 * memory/ (every repaired spelling, `..` and links resolved). Audited.
 */
export function hookWrite(bridge, input) {
  const origin = hookRun(bridge, input);
  const agent = origin && bridge.agentOf(input.agentId);
  if (
    !agent ||
    !origin.effective.memory ||
    !personalCapabilities(agent).memory ||
    isShared(agent) ||
    !["write", "edit"].includes(input.toolName) ||
    !ownMemoryTarget(
      bridge.assistants.runtime?.paths?.workspaces,
      agent.runtimeAgentId,
      input.path,
    )
  )
    return false;
  try {
    bridge.assistants.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: agent.id,
      source: "system",
      outcome: "success",
      details: {
        kind: "native-write",
        via: "hook",
        hookId: origin.hook.id,
        hookEventId: origin.event.id,
        tool: input.toolName,
        filePath: input.path,
      },
    });
  } catch (error) {
    console.error("Hook write audit failed:", error?.message);
  }
  return true;
}

/**
 * Whether a hook session may run a locked core tool, or null for any other session:
 * session_status always; exec and process only while the event runs and the hook's
 * live shell level is not Off; nothing else.
 */
export function hookLockedTool(bridge, input) {
  if (!hookSession(bridge, input)) return null;
  if (input.toolName === "session_status") return true;
  if (!shellTools.includes(input.toolName)) return false;
  const origin = hookRun(bridge, input);
  return !!origin && origin.effective.shell !== "off";
}
