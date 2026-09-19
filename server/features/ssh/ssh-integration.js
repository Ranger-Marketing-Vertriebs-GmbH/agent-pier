import path from "node:path";
import { pidStart } from "../../../vendor/agentbus/core/proc.js";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { privateDirectory, writePrivate, readJSON, problem } from "../../lib/storage.js";
import { tomlValue } from "../../lib/launch-serialization.js";
import { capabilityFile, authorizeSsh, revokeSsh } from "./ssh-capability.js";
import { sshManagementSocket } from "./ssh-management-client.js";
import { createSshProjectBinding } from "./ssh-project-scope.js";
import { prepareSshDiscovery } from "./ssh-discovery.js";
import { addGrant } from "../nono/sandbox-grants.js";
const main = fileURLToPath(new URL("./ssh-mcp.js", import.meta.url));
const supported = (session) =>
  ["codex", "claude", "opencode"].includes(session?.tool) &&
  session.purpose !== "login" &&
  !session.pipeline?.headless;
export class SshIntegration {
  constructor({ dataDir, accounts, onProject, accesses }) {
    this.dataDir = path.resolve(dataDir);
    this.accounts = accounts;
    this.onProject = onProject;
    this.accesses = accesses;
  }
  async prepare({
    id,
    account,
    cwd,
    launch,
    purpose,
    pipeline,
    sandboxProfile,
    sshAccessIds,
  } = {}) {
    if (purpose === "login" || pipeline?.headless) return launch;
    if (account?.tool === "shell") {
      const project = await createSshProjectBinding(cwd);
      await this.onProject?.(project);
      return {
        ...launch,
        sshTools: { enabled: false, project },
      };
    }
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
    const project = await createSshProjectBinding(cwd);
    await this.onProject?.(project);
    // Every host this session may reach: the ids assigned to it explicitly, plus
    // the ones it inherits from its project. A sandboxed session that can reach
    // none is not given the SSH tools at all, because the grants below cannot be
    // narrowed to match — see the comment on the store grant.
    const reachable = new Set([
      ...(sshAccessIds || []),
      ...(this.accesses?.list() || [])
        .filter((access) => access.projectId === project.projectId)
        .map((access) => access.id),
    ]);
    if (sandboxProfile && !reachable.size) return launch;
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
      prepareSshDiscovery({
        tool: selected.tool,
        folder: selected.tool === "claude" ? path.join(folder, "plugin") : folder,
        args,
        env,
      });
      // The CLI spawns the SSH MCP server itself and it reads its generation
      // credential out of the capability folder.
      return [
        { access: "allow", path: folder },
        // authorizeSsh re-reads the session record on every call, so a grant
        // that only covers the file present at launch is not enough: a session
        // record is written to a temporary file and renamed into place on every
        // status update, which replaces what a single-file grant named.
        { access: "read", path: path.join(this.dataDir, "sessions") },
        { access: "read", path: process.execPath },
        { access: "read", path: main },
        // Key generation, key import, host scanning and host registration are
        // management tools, and the MCP server forwards those over this socket
        // instead of touching the store. File access to the socket path confers
        // nothing, so it is declared as its own capability.
        { access: "socket", path: sshManagementSocket(this.dataDir) },
        // The whole store, because it cannot be narrowed while the server still
        // starts: SshAccessStore and SshSessions create and chmod their own
        // directories under `<dataDir>/ssh` at module load, before any tool call
        // and before the broker is reachable, and `ssh` then reads the identity
        // files below that root. The MCP server is a child of the sandboxed CLI
        // and can hold no capability the CLI does not also hold, so this grant
        // is what a sandboxed session with the SSH tools costs. Brokering the
        // rest of the store is the only way to narrow it; `docs/sandbox.md`
        // records that as deferred, and the gate above is why a session that can
        // reach no host never pays the price.
        { access: "allow", path: path.join(this.dataDir, "ssh") },
      ].reduce((granted, grant) => addGrant(granted, grant), {
        ...launch,
        args,
        env,
        sshTools: {
          enabled: true,
          generation,
          project,
          home: env.HOME || process.env.HOME,
        },
      });
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
