import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivate, privateDirectory, problem } from "../../lib/storage.js";
import { tomlValue } from "../../lib/launch-serialization.js";
const main = fileURLToPath(new URL("./session-stdio.js", import.meta.url));

export function sessionMcpLaunch(launch, tool, folder, capability, socketPath) {
  const args = [...(launch.args || [])],
    env = { ...launch.env };
  const command = {
    command: process.execPath,
    args: [main, "--socket", socketPath, "--capability", capability],
  };
  if (
    args.some(
      (arg) =>
        typeof arg === "string" && arg.startsWith("mcp_servers.agentpier_session="),
    )
  )
    throw problem("Reserved AgentPier session MCP name already configured.", 409);
  if (tool === "codex")
    args.push("-c", `mcp_servers.agentpier_session=${tomlValue(command)}`);
  else if (tool === "claude") {
    const plugin = privateDirectory(path.join(folder, "plugin"));
    writePrivate(path.join(plugin, ".claude-plugin", "plugin.json"), {
      name: "agentpier-session",
      version: "1.0.0",
      description: "Session-scoped AgentPier tools.",
    });
    writePrivate(path.join(plugin, ".mcp.json"), {
      mcpServers: { agentpier_session: command },
    });
    args.push("--plugin-dir", plugin);
  } else {
    let config;
    try {
      config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
      if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        (config.mcp !== undefined &&
          (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp))) ||
        Object.hasOwn(config.mcp || {}, "agentpier_session")
      )
        throw Error();
    } catch {
      throw problem("Invalid or conflicting temporary OpenCode MCP configuration.", 409);
    }
    config.mcp = {
      ...config.mcp,
      agentpier_session: {
        type: "local",
        command: [command.command, ...command.args],
        enabled: true,
      },
    };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  }
  return { ...launch, args, env };
}
