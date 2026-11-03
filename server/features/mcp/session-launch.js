import { serverMessages } from "../../lib/i18n/de.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writePrivate, privateDirectory, problem } from "../../lib/storage.js";
import { cliDriver } from "../clis/drivers.js";
import { inlineConfig } from "../clis/opencode/session-config.js";
import { addGrant } from "../nono/sandbox-grants.js";
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
    throw problem(serverMessages.mcp.reservedSessionMcpName, 409);
  if (tool === "opencode")
    try {
      if (Object.hasOwn(inlineConfig(env).mcp || {}, "agentpier_session")) throw Error();
    } catch {
      throw problem(serverMessages.mcp.invalidOpenCodeMcpConfig, 409);
    }
  cliDriver(tool).addMcpServer(
    { args, env },
    { name: "agentpier_session", ...command },
    {
      pluginFolder: () => privateDirectory(path.join(folder, "plugin")),
      manifest: {
        name: "agentpier-session",
        version: "1.0.0",
        description: "Session-scoped AgentPier tools.",
      },
      write: writePrivate,
    },
  );
  // The CLI spawns this stdio bridge itself; only here is its script path in hand.
  return addGrant({ ...launch, args, env }, { access: "read", path: main });
}
