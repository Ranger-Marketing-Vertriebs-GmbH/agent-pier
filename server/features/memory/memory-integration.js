import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProjectMemory } from "./project-memory.js";
import { issueCapability, revokeCapability } from "./memory-capability.js";
import {
  failure,
  identifier,
  record,
  privateFolder,
  writePrivateJson,
} from "./memory-validation.js";
import { tomlValue } from "../../lib/launch-serialization.js";
const main = fileURLToPath(new URL("./memory-mcp.js", import.meta.url));
export class MemoryIntegration {
  constructor({ dataDir, accounts, memory }) {
    this.memory = memory || new ProjectMemory({ dataDir });
    this.owned = !memory;
    this.accounts = accounts;
    this.dataDir = path.dirname(this.memory.root);
  }
  async prepare({ id, account, cwd, launch, purpose } = {}) {
    if (account?.tool === "shell" || purpose === "login") return launch;
    identifier(id);
    const selected = this.accounts ? this.accounts.get(account.id) : account;
    if (
      !selected ||
      !["codex", "claude", "opencode"].includes(selected.tool) ||
      selected.tool !== account.tool
    )
      throw failure("Unsupported memory account.");
    const args = [...(launch.args || [])],
      env = { ...launch.env };
    const command = {
      command: process.execPath,
      args: [main, "--data-dir", this.dataDir, "--session", id],
    };
    let config;
    if (selected.tool === "opencode") {
      try {
        config = record(JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}"));
        if (config.mcp !== undefined) record(config.mcp);
      } catch {
        throw failure("Invalid temporary OpenCode configuration.", 409);
      }
      if (Object.hasOwn(config.mcp || {}, "agentpier_memory"))
        throw failure("Reserved memory MCP name is already configured.", 409);
    }
    if (
      args.some(
        (arg) =>
          typeof arg === "string" && arg.startsWith("mcp_servers.agentpier_memory="),
      )
    )
      throw failure("Reserved memory MCP name is already configured.", 409);
    const project = await this.memory.register(cwd);
    const folder = issueCapability(this.memory, {
      id,
      account: selected,
      projectId: project.id,
    });
    try {
      if (selected.tool === "codex")
        args.push("-c", `mcp_servers.agentpier_memory=${tomlValue(command)}`);
      else if (selected.tool === "claude") {
        const plugin = privateFolder(path.join(folder, "plugin"));
        privateFolder(path.join(plugin, ".claude-plugin"));
        writePrivateJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
          name: "agentpier-memory",
          version: "1.0.0",
          description: "Scope-bound project memory for this AgentPier session.",
        });
        writePrivateJson(path.join(plugin, ".mcp.json"), {
          mcpServers: { agentpier_memory: command },
        });
        args.push("--plugin-dir", plugin);
      } else {
        config.mcp = {
          ...config.mcp,
          agentpier_memory: {
            type: "local",
            command: [command.command, ...command.args],
            enabled: true,
          },
        };
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
      }
      this.accounts?.get(selected.id);
      return { ...launch, args, env, memory: { enabled: true, projectId: project.id } };
    } catch (error) {
      revokeCapability(this.memory, id);
      throw error;
    }
  }
  discard(id) {
    revokeCapability(this.memory, id);
  }
  close() {
    if (this.owned) this.memory.close();
  }
}
