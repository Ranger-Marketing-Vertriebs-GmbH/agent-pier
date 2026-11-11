// The CLI process behind a hook's claim, read by the server outside any sandbox.
import { detectTools } from "../accounts/account-store.js";
import { resolveAgentBusProcess } from "../agentbus/agentbus-process.js";
import { cliDriver } from "../clis/drivers.js";

/**
 * `{ pid, pidStart }` of the CLI that runs in the session's tmux pane above the
 * process `claimedPid` (a hook of that CLI, or the CLI itself for a plugin that runs
 * inside it). The same reading that authenticates an AgentBus registration: the
 * claimed process must descend from the session's own pane, exactly one process
 * between them may be the CLI the account launches, and both are read twice. Throws
 * when any of that does not hold.
 */
export function resolveRuntime({ session, claimedPid, sessions, accounts }) {
  const env = accounts.environment(session.accountId);
  const command = detectTools(env).find((tool) => tool.id === session.tool)?.path;
  if (!command) throw Error("The session's CLI is not installed");
  return resolveAgentBusProcess({
    session,
    launch: {
      id: session.id,
      tool: session.tool,
      command,
      runtimeInterpreter:
        cliDriver(session.tool).runtimeInterpreter?.(command, env) ?? null,
    },
    claimedPid,
    sessions,
  });
}
