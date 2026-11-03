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
 * Adds a session integration as a plugin: `hooks/hooks.json` in the folder
 * `pluginFolder()` returns (it creates `hooks/` and `.claude-plugin/`), one hook per
 * event of `events` ({ [event]: timeoutSeconds }) running `script` with the event name,
 * then the MCP `server` with its `manifest` (addMcpServer). `write(file, value)` and
 * `quote(value)` come from the caller.
 */
export function addSessionHooks(
  launch,
  { script, events, server, pluginFolder, manifest, write, quote },
) {
  const hooks = Object.fromEntries(
    Object.entries(events).map(([event, timeout]) => [
      event,
      [
        {
          hooks: [
            {
              type: "command",
              command: [process.execPath, script, event].map(quote).join(" "),
              timeout,
            },
          ],
        },
      ],
    ]),
  );
  write(path.join(pluginFolder(), "hooks/hooks.json"), { hooks });
  addMcpServer(launch, server, { pluginFolder, manifest, write });
}

/**
 * Writes the plugin `manifest` into `folder` with `write(file, value)` and passes the
 * folder to Claude Code, so a later start hook (addReminder) has a plugin to live in.
 * Returns the folder.
 */
export function addPluginFolder(launch, { folder, manifest, write }) {
  write(path.join(folder, ".claude-plugin", "plugin.json"), manifest);
  launch.args.push("--plugin-dir", folder);
  return folder;
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
