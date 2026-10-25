import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import {
  chooseTmuxSocket,
  tmuxSocketPaths,
} from "../../server/features/sessions/tmux-naming.js";
import { legacyTmuxSessions } from "../../server/features/sessions/legacy-tmux-server.js";

const exec = promisify(execFile);
const tmuxPath = process.env.TMUX_PATH || "tmux";

const names = async (socket) =>
  (
    await exec(tmuxPath, ["-S", socket, "list-sessions", "-F", "#{session_name}"]).catch(
      () => ({ stdout: "" }),
    )
  ).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .sort();

const shell = (id, name, cwd) => ({
  id,
  name,
  cwd,
  tool: "codex",
  accountId: "fixture-account",
  command: "/bin/sh",
  args: ["-c", "echo READY; sleep 60"],
  env: { PATH: "/usr/bin:/bin" },
});

/**
 * A data directory whose tmux server still runs on the legacy socket, as after an
 * update from a release from before the rename, with AgentPier's sessions on it. Every
 * socket lives under /tmp, hashed from this temporary data directory.
 */
async function legacyServer(t, sessions) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-legacy-drain-"));
  const sockets = tmuxSocketPaths(dataDir);
  const managers = [];
  t.after(async () => {
    for (const manager of managers) await manager.close().catch(() => {});
    for (const file of Object.values(sockets)) {
      await exec(tmuxPath, ["-S", file, "kill-server"]).catch(() => {});
      await rm(path.dirname(file), { recursive: true, force: true });
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  await mkdir(path.dirname(sockets.legacy), { mode: 0o700 });
  // A session of the earlier release keeps the server in use until the fixture's start.
  await exec(tmuxPath, [
    "-S",
    sockets.legacy,
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "tuiui-boot",
  ]);
  const start = async () => {
    const manager = new SessionManager({ dataDir, tmuxPath });
    managers.push(manager);
    await manager.ready;
    return manager;
  };
  const manager = await start();
  assert.equal(manager.socketPath, sockets.legacy);
  // The legacy server runs with AgentPier's configuration (exit-empty off).
  await manager.tmux(["source-file", manager.configPath]);
  for (const [id, name] of sessions) await manager.create(shell(id, name, dataDir));
  await exec(tmuxPath, ["-S", sockets.legacy, "kill-session", "-t", "=tuiui-boot"]);
  return { dataDir, sockets, manager, start };
}

const byId = (sessions) => [...sessions].sort((a, b) => a.id.localeCompare(b.id));

test("sessions on the legacy server are reported until the last one stops", async (t) => {
  const { dataDir, sockets, manager, start } = await legacyServer(t, [
    ["alpha", "Alpha review"],
    ["beta", "Beta fix"],
  ]);
  assert.deepEqual(byId(await legacyTmuxSessions(manager)), [
    { id: "alpha", name: "Alpha review" },
    { id: "beta", name: "Beta fix" },
  ]);
  await manager.stop("alpha");
  assert.deepEqual(await legacyTmuxSessions(manager), [{ id: "beta", name: "Beta fix" }]);

  // While one runs there, new sessions keep joining the legacy server.
  await manager.create(shell("gamma", "Gamma", dataDir));
  assert.equal(manager.socketPath, sockets.legacy);
  assert.deepEqual(await names(sockets.legacy), ["agentpier-beta", "agentpier-gamma"]);
  await manager.stop("beta");
  await manager.stop("gamma");
  assert.deepEqual(await legacyTmuxSessions(manager), []);

  // None is left: the next session starts on the new server, and AgentPier stays there.
  await manager.create(shell("delta", "Delta", dataDir));
  assert.equal(manager.socketPath, sockets.produced);
  assert.deepEqual(await names(sockets.produced), ["agentpier-delta"]);
  assert.equal((await manager.get("delta")).status, "running");
  assert.deepEqual(await legacyTmuxSessions(manager), []);
  // The legacy server is left running, never killed.
  await exec(tmuxPath, ["-S", sockets.legacy, "list-sessions"]);
  assert.equal(chooseTmuxSocket(dataDir, { tmuxPath }), sockets.produced);
  const restarted = await start();
  assert.equal(restarted.socketPath, sockets.produced);
  assert.equal((await restarted.get("delta")).status, "running");
});

test("a relaunch of the last legacy session starts it on the new server", async (t) => {
  const { sockets, manager } = await legacyServer(t, [["solo", "Solo"]]);
  await manager.updateReload("solo", { state: "reloading", nativeId: "fixture" });
  const result = await manager.replace("solo", async () => ({
    command: "/bin/sh",
    args: ["-c", "sleep 60"],
    env: {},
  }));
  assert.equal(result.status, "running");
  assert.equal(manager.socketPath, sockets.produced);
  assert.deepEqual(await names(sockets.produced), ["agentpier-solo"]);
  assert.deepEqual(await names(sockets.legacy), []);
});

test("a session that exited on the legacy server is recorded before the move", async (t) => {
  const { dataDir, sockets, manager } = await legacyServer(t, [["quiet", "Quiet"]]);
  await manager.save({ ...(await manager.metadata("quiet")), status: "running" });
  await manager.tmux(["respawn-pane", "-k", "-t", "=agentpier-quiet:0.0", "true"]);
  const until = Date.now() + 5000;
  while ((await legacyTmuxSessions(manager)).length && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(await legacyTmuxSessions(manager), [], "the pane is dead");
  assert.equal((await manager.metadata("quiet")).status, "running", "not seen yet");
  await manager.create(shell("next", "Next", dataDir));
  assert.equal(manager.socketPath, sockets.produced);
  const quiet = await manager.metadata("quiet");
  assert.equal(quiet.status, "stopped");
  assert.equal(quiet.interruption, undefined, "an exit, not a lost server");
  // Its dead pane stays on the legacy server.
  assert.deepEqual(await names(sockets.legacy), ["agentpier-quiet"]);
});
