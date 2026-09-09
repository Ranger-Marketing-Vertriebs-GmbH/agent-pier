import path from "node:path";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { privateDirectory, writePrivate, readJSON, problem } from "../../lib/storage.js";
import { tomlValue } from "../../lib/launch-serialization.js";
import { capabilityFile, authorizeSsh, revokeSsh } from "./ssh-capability.js";
const main = fileURLToPath(new URL("./ssh-mcp.js", import.meta.url));
const supported = (session) =>
  ["codex", "claude", "opencode"].includes(session?.tool) &&
  session.purpose !== "login" &&
  !session.pipeline?.headless;
export class SshIntegration {
  constructor({ dataDir, accounts }) {
    this.dataDir = path.resolve(dataDir);
    this.accounts = accounts;
  }
  async prepare({ id, account, launch, purpose, pipeline } = {}) {
    if (purpose === "login" || pipeline?.headless || account?.tool === "shell")
      return launch;
    const selected = this.accounts ? this.accounts.get(account.id) : account;
    if (!supported(selected) || selected.tool !== account.tool)
      throw problem("Unsupported SSH tool account.");
    const args = [...(launch.args || [])],
      env = { ...launch.env };
    let config;
    if (selected.tool === "opencode") {
      try {
        config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}");
        if (
          !config ||
          Array.isArray(config) ||
          typeof config !== "object" ||
          (config.mcp !== undefined &&
            (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)))
        )
          throw Error();
      } catch {
        throw problem("Invalid temporary OpenCode configuration.", 409);
      }
      if (Object.hasOwn(config.mcp || {}, "agentpier_ssh"))
        throw problem("Reserved SSH MCP name already configured.", 409);
    }
    if (
      args.some(
        (arg) => typeof arg === "string" && arg.startsWith("mcp_servers.agentpier_ssh="),
      )
    )
      throw problem("Reserved SSH MCP name already configured.", 409);
    const file = capabilityFile(this.dataDir, id);
    const generation = randomUUID();
    // Each process receives an immutable generation-specific credential file.
    this.discard(id);
    const folder = privateDirectory(path.dirname(file));
    const credentialFile = path.join(folder, `${generation}.json`);
    const capability = {
      sessionId: id,
      accountId: selected.id,
      tool: selected.tool,
      generation,
      token: randomBytes(32).toString("hex"),
    };
    writePrivate(file, capability);
    writePrivate(credentialFile, capability);
    const command = {
      command: process.execPath,
      args: [main, "--data-dir", this.dataDir, "--capability", credentialFile],
    };
    try {
      if (selected.tool === "codex")
        args.push("-c", `mcp_servers.agentpier_ssh=${tomlValue(command)}`);
      else if (selected.tool === "claude") {
        const plugin = privateDirectory(path.join(folder, "plugin"));
        writePrivate(path.join(plugin, ".claude-plugin", "plugin.json"), {
          name: "agentpier-ssh",
          version: "1.0.0",
          description: "Assigned SSH hosts for this session.",
        });
        writePrivate(path.join(plugin, ".mcp.json"), {
          mcpServers: { agentpier_ssh: command },
        });
        args.push("--plugin-dir", plugin);
      } else {
        config.mcp = {
          ...config.mcp,
          agentpier_ssh: {
            type: "local",
            command: [command.command, ...command.args],
            enabled: true,
          },
        };
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      }
      return { ...launch, args, env, sshTools: { enabled: true, generation } };
    } catch (error) {
      this.discard(id);
      throw error;
    }
  }
  discard(id) {
    revokeSsh(this.dataDir, id);
  }
  status(session) {
    const result = { enabled: false, ready: false, state: "unavailable" };
    if (!supported(session) || session.status !== "running") return result;
    result.state = "reload-required";
    try {
      const file = capabilityFile(this.dataDir, session.id);
      const capability = readJSON(file, null);
      authorizeSsh(this.dataDir, capability);
      if (capability.generation !== session.sshTools?.generation) return result;
      Object.assign(result, {
        enabled: true,
        generation: capability.generation,
        state: "starting",
      });
      const ready = readJSON(path.join(path.dirname(file), "ready.json"), null);
      if (
        ready?.generation === capability.generation &&
        Number.isInteger(ready.pid) &&
        ready.pid > 0 &&
        typeof ready.pidStart === "string" &&
        pidStart(ready.pid) === ready.pidStart &&
        Number.isInteger(ready.parentPid) &&
        ready.parentPid > 1 &&
        typeof ready.parentStart === "string" &&
        pidStart(ready.parentPid) === ready.parentStart
      ) {
        process.kill(ready.pid, 0);
        Object.assign(result, { ready: true, state: "ready" });
      }
    } catch {
      /* Missing capabilities and exited transports are not ready. */
    }
    return result;
  }
}
