// How a session launch hands OpenCode an extra MCP server or start hint: entries in the
// inline configuration OPENCODE_CONFIG_CONTENT, merged with what it already holds.
import { grantOpenCode } from "./attachments.js";

const isRecord = (value) => value && typeof value === "object" && !Array.isArray(value);

/**
 * The launch's inline OpenCode configuration; throws when it, or its `mcp` member, is
 * not an object. Callers check it before they change anything, with their own error.
 */
export function inlineConfig(env) {
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
  if (!isRecord(config) || (config.mcp !== undefined && !isRecord(config.mcp)))
    throw Error("Invalid OpenCode configuration");
  return config;
}

export function addMcpServer(launch, { name, command, args, env, toolTimeoutSec }) {
  const config = inlineConfig(launch.env);
  config.mcp = {
    ...config.mcp,
    [name]: {
      type: "local",
      command: [command, ...args],
      ...(env ? { environment: env } : {}),
      enabled: true,
      // OpenCode passes the server's request timeout to every tool call.
      ...(toolTimeoutSec ? { timeout: toolTimeoutSec * 1000 } : {}),
    },
  };
  launch.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
}

/**
 * Adds the `pluginUrl` module URL to the configuration's plugins once. `invalid()` builds
 * the error for a configuration or plugin list that is not valid.
 */
export function addReminder(launch, { pluginUrl, invalid }) {
  let config;
  try {
    config = JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT || "{}");
    if (!isRecord(config)) throw Error("Invalid configuration");
    if (
      config.plugin !== undefined &&
      (!Array.isArray(config.plugin) ||
        config.plugin.some((value) => typeof value !== "string"))
    )
      throw Error("Invalid plugins");
  } catch {
    throw invalid();
  }
  config.plugin = [...new Set([...(config.plugin || []), pluginUrl])];
  launch.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
}

/**
 * Adds a session integration: appends the `pluginUrl` module URL to the configuration's
 * plugins (the plugin bridges hooks and tools itself, so `events` and `server` are not
 * used). `invalid()` builds the error for a configuration or plugin list that is not
 * valid.
 */
export function addSessionHooks(launch, { pluginUrl, invalid }) {
  const { env } = launch;
  let config = {};
  try {
    if (env.OPENCODE_CONFIG_CONTENT) config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  } catch {
    throw invalid();
  }
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    (config.plugin !== undefined && !Array.isArray(config.plugin))
  )
    throw invalid();
  config.plugin = [...(config.plugin || []), pluginUrl];
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
}

/** Names of the MCP servers the inline configuration holds; throws when it is invalid. */
export function inlineMcpNames(env) {
  return Object.keys(inlineConfig(env).mcp || {});
}

/**
 * Grants the chat attachments through the account's references entry (see
 * attachments.js), which covers every session of the account, then creates the
 * session `directory` with `ensure()`. `profile` is a function returning the profile
 * location, read only here. A reload finds the entry in place and changes nothing.
 */
export function grantDirectory(
  launch,
  directory,
  { reload, ensure, profile, accountDirectory },
) {
  if (reload) return true;
  return grantOpenCode(profile(), accountDirectory) && ensure();
}
