// How a session launch hands Claude Code an extra MCP server or start hook: a plugin
// folder passed with --plugin-dir.
import fs from "node:fs";
import path from "node:path";
import { resolveAgentBusInterpreter } from "../../agentbus/agentbus-launch-identity.js";
import { shellQuote } from "../../../lib/launch-serialization.js";
import {
  privateFolder,
  record,
  writePrivateJson,
} from "../../memory/memory-validation.js";

/**
 * Writes the plugin's manifest and `.mcp.json` with the caller's `write(file, value)`
 * into the folder `plugin()` creates and returns, and passes that folder to Claude
 * Code. Each integration keeps its own folder and file format.
 */
export function addMcpServer(
  launch,
  { name, command, args, env },
  { pluginFolder, manifest, write },
) {
  const folder = pluginFolder();
  write(path.join(folder, ".claude-plugin", "plugin.json"), manifest);
  write(path.join(folder, ".mcp.json"), {
    mcpServers: { [name]: { command, args, ...(env ? { env } : {}) } },
  });
  launch.args.push("--plugin-dir", folder);
}

/**
 * Adds the hook to SessionStart in `folder/hooks/hooks.json` of a plugin the launch
 * already passes, keeping the hooks the file holds. `invalid()` builds the error for a
 * file that is not a hook configuration.
 */
export function addReminder(launch, { script, folder, invalid }) {
  const hook = {
    hooks: [
      {
        type: "command",
        command: [process.execPath, script].map(shellQuote).join(" "),
        timeout: 5,
      },
    ],
  };
  const directory = privateFolder(path.join(folder, "hooks"));
  const file = path.join(directory, "hooks.json");
  let config = {};
  try {
    config = record(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw invalid();
  }
  let hooks;
  try {
    hooks = config.hooks === undefined ? {} : record(config.hooks);
  } catch {
    throw invalid();
  }
  if (hooks.SessionStart !== undefined && !Array.isArray(hooks.SessionStart))
    throw invalid();
  writePrivateJson(file, {
    ...config,
    hooks: { ...hooks, SessionStart: [...(hooks.SessionStart || []), hook] },
  });
}

/** Names of the MCP servers the launch environment already holds inline: none. */
export function inlineMcpNames() {
  return [];
}

/** The Node interpreter behind an installed JavaScript entrypoint, or null. */
export function runtimeInterpreter(command, env) {
  return resolveAgentBusInterpreter(command, env);
}

/**
 * Adds the chat attachment `directory` with --add-dir. A first launch creates it with
 * `ensure()` first and grants nothing when that fails; a reload re-adds it as is.
 */
export function grantDirectory(launch, directory, { reload, ensure }) {
  if (!reload && !ensure()) return false;
  launch.args.push("--add-dir", directory);
  return true;
}
