import { serverMessages } from "../../lib/i18n/de.js";
import {
  shellQuote as quote,
  tomlValue as toml,
} from "../../lib/launch-serialization.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { problem } from "../../lib/storage.js";
import {
  trustedPeers,
  trustedIdentities,
  loadLaunch,
} from "../../../vendor/agentbus/agentpier/runtime.js";
import { ensureDir, writeJsonAtomic } from "../../../vendor/agentbus/core/fsx.js";
import { peerKey } from "../../../vendor/agentbus/core/paths.js";
import { openQueue } from "../../../vendor/agentbus/core/queue.js";

const vendor = fileURLToPath(new URL("../../../vendor/agentbus/", import.meta.url));
const VERSION = "agentpier-1";
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

export class AgentBus {
  constructor({ dataDir, home = os.homedir(), accounts, sessions }) {
    this.dataDir = fs.realpathSync(dataDir);
    this.home = home;
    this.accounts = accounts;
    this.sessions = sessions;
    this.root = path.join(this.dataDir, "agentbus");
    this.queues = new Map();
  }

  queue(home) {
    let value = this.queues.get(home);
    if (!value) {
      value = openQueue(home);
      this.queues.set(home, value);
    }
    return value;
  }
  async prepare({
    id,
    account,
    cwd,
    launch,
    enabled = true,
    purpose,
    replace = false,
  } = {}) {
    if (enabled === false || purpose === "login")
      return { ...launch, agentbus: { enabled: false } };
    if (!idPattern.test(id || "")) throw problem(serverMessages.agentbus.invalidSession);
    const selected = this.accounts.get(account?.id);
    if (selected.tool !== account.tool)
      throw problem(serverMessages.common.profileChanged, 409);
    const canonical = fs.realpathSync(cwd);
    if (!fs.statSync(canonical).isDirectory())
      throw problem(serverMessages.common.invalidProjectDirectory);
    const projectId = createHash("sha256").update(canonical).digest("hex");
    const home = path.join(this.root, "projects", projectId);
    ensureDir(path.join(home, "launches"));
    const existing = path.join(home, "launches", `${id}.json`);
    if (fs.existsSync(existing) && !replace)
      throw problem(serverMessages.agentbus.sessionAlreadyExists, 409);
    const originalEnv = { ...launch.env };
    const env = {
      ...originalEnv,
      AGENTBUS_HOME: home,
      AGENTPIER_AGENTBUS_SESSION: id,
      AGENTBUS_SOCKET_DIR: `/tmp/ap-bus-${process.getuid?.() || 0}-${createHash("sha256").update(home).digest("hex").slice(0, 12)}`,
    };
    const record = {
      id,
      projectId,
      cwd: canonical,
      accountId: selected.id,
      tool: selected.tool,
      command: launch.command,
      node: process.execPath,
      codexHome:
        originalEnv.CODEX_HOME || path.join(originalEnv.HOME || this.home, ".codex"),
      claudeSessionsDir: path.join(
        originalEnv.CLAUDE_CONFIG_DIR ||
          path.join(originalEnv.HOME || this.home, ".claude"),
        "sessions",
      ),
      createdAt: new Date().toISOString(),
    };
    const args = [...(launch.args || [])];
    const mcp = path.join(vendor, "agentpier/mcp.js");
    const hook = path.join(vendor, "agentpier/hook.js");
    const bridgeEnv = {
      AGENTBUS_HOME: home,
      AGENTPIER_AGENTBUS_SESSION: id,
      AGENTBUS_SOCKET_DIR: env.AGENTBUS_SOCKET_DIR,
    };
    const hooks = Object.fromEntries(
      ["SessionStart", "UserPromptSubmit", "SessionEnd"].map((event) => [
        event,
        [
          {
            hooks: [
              {
                type: "command",
                command: [process.execPath, hook, event].map(quote).join(" "),
                timeout: event === "SessionEnd" ? 3 : 10,
              },
            ],
          },
        ],
      ]),
    );
    if (selected.tool === "codex") {
      args.push(
        "-c",
        `mcp_servers.agentpier_agentbus=${toml({ command: process.execPath, args: [mcp], env: bridgeEnv })}`,
      );
      // Codex loads hooks independently from each active config layer. The session layer
      // adds these definitions; it does not replace user/project hooks or their trust.
      for (const [event, definitions] of Object.entries(hooks))
        args.push("-c", `hooks.${event}=${toml(definitions)}`);
    } else if (selected.tool === "claude") {
      const plugin = path.join(home, "adapters", id);
      ensureDir(path.join(plugin, ".claude-plugin"));
      ensureDir(path.join(plugin, "hooks"));
      writeJsonAtomic(path.join(plugin, ".claude-plugin/plugin.json"), {
        name: "agentpier-agentbus",
        version: "1.0.0",
        description: "AgentBus for this AgentPier session",
        license: "MIT",
      });
      writeJsonAtomic(path.join(plugin, "hooks/hooks.json"), { hooks });
      writeJsonAtomic(path.join(plugin, ".mcp.json"), {
        mcpServers: {
          agentpier_agentbus: {
            command: process.execPath,
            args: [mcp],
            env: bridgeEnv,
          },
        },
      });
      args.push("--plugin-dir", plugin);
    } else if (selected.tool === "opencode") {
      let config = {};
      try {
        if (env.OPENCODE_CONFIG_CONTENT) config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      } catch {
        throw problem(serverMessages.common.invalidTemporaryOpenCodeConfig, 409);
      }
      if (
        !config ||
        typeof config !== "object" ||
        Array.isArray(config) ||
        (config.plugin !== undefined && !Array.isArray(config.plugin))
      )
        throw problem(serverMessages.common.invalidTemporaryOpenCodeConfig, 409);
      const plugin = pathToFileURL(path.join(vendor, "agentpier/opencode.js")).href;
      config.plugin = [...(config.plugin || []), plugin];
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
    } else throw problem(serverMessages.common.unknownCliTool);
    this.accounts.get(selected.id);
    writeJsonAtomic(existing, record);
    return {
      ...launch,
      args,
      env,
      agentbus: { enabled: true, projectId, version: VERSION },
    };
  }
  async list() {
    const projects = new Map();
    const sessions = await this.sessions.list();
    for (const session of sessions) {
      if (
        !session.agentbus?.enabled ||
        !idPattern.test(session.id) ||
        !/^\w{64}$/.test(session.agentbus.projectId || "")
      )
        continue;
      const h = path.join(this.root, "projects", session.agentbus.projectId);
      let launch;
      try {
        launch = loadLaunch(h, session.id);
      } catch {
        continue;
      }
      if (launch.accountId !== session.accountId || launch.tool !== session.tool)
        continue;
      let project = projects.get(launch.projectId);
      if (!project) {
        project = {
          id: launch.projectId,
          name: path.basename(launch.cwd),
          cwd: launch.cwd,
          sessions: [],
        };
        projects.set(launch.projectId, project);
      }
      const peers = trustedPeers(h).filter(
        (peer) => peer.agentpierSessionId === session.id,
      );
      let pending = 0;
      for (const peer of trustedIdentities(h).filter(
        (peer) => peer.agentpierSessionId === session.id,
      ))
        try {
          pending += this.queue(h).summary(peer.key).count;
        } catch {}
      const registered = session.status === "running" && peers.some((peer) => peer.alive);
      project.sessions.push({
        id: session.id,
        name: session.name,
        tool: session.tool,
        status: session.status,
        pending,
        registered,
        ...(session.status === "running" && !registered
          ? {
              reason:
                session.tool === "codex"
                  ? serverMessages.agentbus.codexRegistrationPending
                  : serverMessages.agentbus.nativeRegistrationPending,
            }
          : {}),
      });
    }
    return {
      bundled: true,
      version: VERSION,
      projects: [...projects.values()],
      note: serverMessages.agentbus.overviewNotice,
    };
  }
  async discard({ id, projectId }) {
    if (!idPattern.test(id || "") || !/^[a-f0-9]{64}$/.test(projectId || "")) return;
    if ((await this.sessions.list()).some((session) => session.id === id)) return;
    const home = path.join(this.root, "projects", projectId);
    loadLaunch(home, id);
    if (trustedPeers(home).some((peer) => peer.agentpierSessionId === id && peer.alive))
      return;
    fs.rmSync(path.join(home, "launches", `${id}.json`), { force: true });
    fs.rmSync(path.join(home, "adapters", id), {
      recursive: true,
      force: true,
    });
  }
  async messages(projectId, { page = 1 } = {}) {
    if (
      typeof projectId !== "string" ||
      !/^[a-f0-9]{64}$/.test(projectId) ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 10000
    )
      throw problem(serverMessages.agentbus.invalidHistoryPage);
    const sessions = (await this.sessions.list()).filter(
      (session) => session.agentbus?.enabled && session.agentbus.projectId === projectId,
    );
    if (!sessions.length) throw problem(serverMessages.agentbus.projectNotFound, 404);
    const h = path.join(this.root, "projects", projectId);
    const owned = new Set();
    for (const session of sessions)
      try {
        const launch = loadLaunch(h, session.id);
        if (launch.accountId === session.accountId && launch.tool === session.tool)
          owned.add(session.id);
      } catch {}
    if (!owned.size) throw problem(serverMessages.agentbus.projectNotFound, 404);
    const peers = trustedIdentities(h).filter((peer) =>
      owned.has(peer.agentpierSessionId),
    );
    const byKey = new Map(peers.map((peer) => [peer.key, peer]));
    const items = new Map();
    let scanned = 0;
    let truncated = false;
    scan: for (const recipient of peers) {
      let rows;
      try {
        rows = this.queue(h).rows({ recipient: recipient.key, limit: 5000 });
      } catch {
        continue;
      }
      for (const message of rows) {
        if (++scanned > 5000) {
          truncated = true;
          break scan;
        }
        try {
          const key = peerKey(message.from?.runtime, message.from?.sessionId);
          const sender = byKey.get(key);
          if (!sender) continue;
          const createdAt = new Date(message.ts).toISOString();
          items.set(message.id, {
            id: message.id,
            from: { name: sender.name, tool: sender.runtime, key },
            to: {
              name: recipient.name,
              tool: recipient.runtime,
              key: recipient.key,
            },
            text: message.text,
            createdAt,
            status: message.status === "acked" ? "read" : "pending",
          });
        } catch {
          /* Invalid or concurrently changed rows do not become public history. */
        }
      }
    }
    const sorted = [...items.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    return {
      projectId,
      page,
      pageSize: 20,
      total: sorted.length,
      items: sorted.slice((page - 1) * 20, page * 20),
      truncated,
      ...(truncated
        ? {
            note: serverMessages.agentbus.historyScanLimit,
          }
        : {}),
    };
  }
  async close() {
    for (const queue of this.queues.values()) queue.close();
    this.queues.clear();
  } // Runtime files and peers survive server restarts with their tmux sessions.
}
