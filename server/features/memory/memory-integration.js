import path from "node:path";
import { prepareMemoryDiscovery } from "./memory-discovery.js";
import { MemoryBroker } from "./memory-broker.js";
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
import { addGrant } from "../nono/sandbox-grants.js";
const main = fileURLToPath(new URL("./memory-mcp.js", import.meta.url));
export class MemoryIntegration {
  constructor({ dataDir, accounts, memory }) {
    this.memory = memory || new ProjectMemory({ dataDir });
    this.owned = !memory;
    this.accounts = accounts;
    this.broker = new MemoryBroker(this.memory);
    this.ready = this.broker.ready.catch((error) => {
      if (this.owned) this.memory.close();
      throw error;
    });
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
    await this.ready;
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
    const command = {
      command: process.execPath,
      args: [
        main,
        "--socket",
        this.broker.socketPath,
        "--capability",
        path.join(folder, "capability.json"),
      ],
    };
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
      prepareMemoryDiscovery({
        tool: selected.tool,
        folder: selected.tool === "claude" ? path.join(folder, "plugin") : folder,
        args,
        env,
      });
      this.accounts?.get(selected.id);
      const prepared = {
        ...launch,
        args,
        env,
        memory: { enabled: true, projectId: project.id },
      };
      // The CLI spawns the memory MCP server itself, so a sandboxed session needs
      // the node binary and that server script on top of the memory store it reads
      // and writes. The store is this.memory.root: this.dataDir is its parent, the
      // whole AgentPier data directory, which holds every other feature's secrets.
      // The server reaches the store over the broker socket, which file access to
      // that path does not confer.
      return [
        { access: "allow", path: this.memory.root },
        { access: "allow", path: folder },
        { access: "read", path: process.execPath },
        { access: "read", path: main },
        { access: "socket", path: this.broker.socketPath },
      ].reduce((granted, grant) => addGrant(granted, grant), prepared);
    } catch (error) {
      revokeCapability(this.memory, id);
      throw error;
    }
  }
  discard(id) {
    revokeCapability(this.memory, id);
  }
  async close() {
    try {
      await this.ready.catch(() => {});
      await this.broker.close();
    } finally {
      if (this.owned) this.memory.close();
    }
  }
}
