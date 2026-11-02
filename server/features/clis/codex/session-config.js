// How a session launch hands Codex an extra MCP server or start hook: `-c` overrides.
import { parse as parseToml } from "smol-toml";
import { codexHookCommand } from "../../../lib/codex-hook-command.js";
import { tomlValue } from "../../../lib/launch-serialization.js";

export function addMcpServer(launch, { name, command, args, env }) {
  const entry = { command, args, ...(env ? { env } : {}) };
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
