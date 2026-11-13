// How a session launch hands Codex an extra MCP server or start hook: `-c` overrides.
import { parse as parseToml } from "smol-toml";
import { codexHookCommand } from "../../../lib/codex-hook-command.js";
import { tomlValue } from "../../../lib/launch-serialization.js";
import { codexSandboxArguments } from "../../../lib/sandbox.js";

export function addMcpServer(launch, { name, command, args, env, toolTimeoutSec }) {
  const entry = {
    command,
    args,
    ...(env ? { env } : {}),
    ...(toolTimeoutSec ? { tool_timeout_sec: toolTimeoutSec } : {}),
  };
  launch.args.push("-c", `mcp_servers.${name}=${tomlValue(entry)}`);
}

/**
 * Adds the hook to the session's SessionStart list: into the last `-c
 * hooks.SessionStart=` override when the launch already has one, so an earlier hook
 * stays, otherwise as a new override. `invalid()` builds the error for an override
 * that is not a hook list.
 */
export function addReminder(launch, { name, script, invalid }) {
  const { args, env } = launch;
  const hook = {
    hooks: [
      { type: "command", command: codexHookCommand(env, name, script), timeout: 5 },
    ],
  };
  const key = "hooks.SessionStart=";
  let index = -1;
  for (let i = 1; i < args.length; i++)
    if (args[i].startsWith(key) && ["-c", "--config"].includes(args[i - 1])) index = i;
  if (index < 0) args.push("-c", key + tomlValue([hook]));
  else {
    let entries;
    try {
      entries = parseToml(args[index]).hooks.SessionStart;
      if (!Array.isArray(entries)) throw Error("Invalid hooks");
    } catch {
      throw invalid();
    }
    args[index] = key + tomlValue([...entries, hook]);
  }
}

/**
 * Adds a session integration: its MCP `server` (when given), then one `-c
 * hooks.<event>=` override per event of `events` ({ [event]: timeoutSeconds }), each
 * running `script` with the event name under the managed hook `name`. Codex loads
 * hooks independently from each active config layer, so these definitions do not
 * replace user/project hooks or their trust.
 */
export function addSessionHooks(launch, { name, script, events, server }) {
  const { args, env } = launch;
  const hooks = Object.entries(events).map(([event, timeout]) => [
    event,
    [
      {
        hooks: [
          {
            type: "command",
            command: codexHookCommand(env, name, script, [event]),
            timeout,
          },
        ],
      },
    ],
  ]);
  if (server) addMcpServer(launch, server);
  for (const [event, definitions] of hooks)
    args.push("-c", `hooks.${event}=${tomlValue(definitions)}`);
}

/** Names of the MCP servers the launch environment already holds inline: none. */
export function inlineMcpNames() {
  return [];
}

/**
 * Adds the chat attachment `directory` with --add-dir, like Claude Code. Codex ignores
 * the flag while its sandbox stays read-only, which is its default. The YOLO launch
 * mode already runs without a sandbox, so pinning workspace-write there would only
 * narrow what the operator asked for; every other mode has the sandbox raised to make
 * the grant real (on a reload only when the launch does not pin it already).
 */
export function grantDirectory(launch, directory, { reload, ensure }) {
  if (!reload && !ensure()) return false;
  launch.args.push("--add-dir", directory);
  const sandbox = codexSandboxArguments();
  if (launch.launchMode !== "yolo" && (!reload || !launch.args.includes(sandbox[1])))
    launch.args.push(...sandbox);
  return true;
}
