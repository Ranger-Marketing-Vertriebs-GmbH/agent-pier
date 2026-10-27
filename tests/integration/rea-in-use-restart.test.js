import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { McpServerStore } from "../../server/features/mcp-servers/mcp-server-store.js";
import { reaInUse } from "../../server/application/rea-wiring.js";

const execute = promisify(execFile);

// Review focus 2: a Claude Code session that binds REA keeps running in tmux while
// AgentPier restarts. The new SessionManager reads it from tmux as running before
// rea.start() asks, so REA's server-start update and removals wait for it.
test("reaInUse sees a session that survived an AgentPier restart in tmux", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rea-in-use-")));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { mode: 0o700 });
  const managers = [];
  const open = async () => {
    const manager = new SessionManager({ dataDir });
    managers.push(manager);
    await manager.ready;
    return manager;
  };
  const servers = new McpServerStore({
    dataDir,
    pathEnv: "/fake/bin",
    exists: () => true,
  });
  t.after(async () => {
    const last = managers.at(-1);
    await last?.stop("claude-rea").catch(() => {});
    for (const manager of managers) await manager.close().catch(() => {});
    if (last) {
      await execute("tmux", ["-S", last.socketPath, "kill-server"]).catch(() => {});
      await fs.rm(path.dirname(last.socketPath), { recursive: true, force: true });
    }
    servers.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const row = servers.create(
    { name: "rea", transport: "stdio", command: "/fake/bin/rea", args: [] },
    { managed: { tool: "rea" }, bind: [["cli", "claude"]] },
  );
  const ready = path.join(root, "ready");
  const child = path.join(root, "claude.cjs");
  await fs.writeFile(
    child,
    `require("node:fs").writeFileSync(${JSON.stringify(ready)}, "up"); setInterval(() => {}, 1000);`,
  );
  const first = await open();
  await first.create({
    id: "claude-rea",
    name: "Claude with REA",
    accountId: "local-claude",
    tool: "claude",
    cwd: root,
    command: process.execPath,
    args: [child],
    env: { PATH: path.dirname(process.execPath), HOME: root },
  });
  for (let i = 0; i < 250 && !(await fs.stat(ready).catch(() => null)); i += 1)
    await delay(20);
  // AgentPier restarts: the old manager goes, tmux and the session stay.
  await first.close();
  const restarted = await open();
  const ask = () => reaInUse({ serverId: row.id, servers, sessions: restarted });
  assert.equal(await ask(), true);
  await restarted.stop("claude-rea");
  assert.equal(await ask(), false);
});
