import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const noServer = async (socket) =>
  assert.rejects(exec(tmuxPath, ["-S", socket, "list-sessions"]), "no server there");
const quietly = (t) => t.mock.method(console, "error", () => {});

async function eventually(fn, message, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

test("the old server is ended once only finished sessions remain on it", async (t) => {
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

  // None is left: the old server ends and the next session starts on the new one.
  await manager.create(shell("delta", "Delta", dataDir));
  assert.equal(manager.socketPath, sockets.produced);
  assert.deepEqual(await names(sockets.produced), ["agentpier-delta"]);
  assert.equal((await manager.get("delta")).status, "running");
  assert.deepEqual(await legacyTmuxSessions(manager), []);
  // Rollback safety: no server is left on the legacy socket for an older release to
  // pick, so it reaches the agentpier one, and so does a restart.
  await noServer(sockets.legacy);
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
  await noServer(sockets.legacy);
});

test("an exit not seen yet is recorded with its screen before the old server ends", async (t) => {
  const { dataDir, sockets, manager } = await legacyServer(t, [["quiet", "Quiet"]]);
  await manager.tmux(["respawn-pane", "-k", "-t", "=agentpier-quiet:0.0", "echo BYE"]);
  await eventually(
    async () => !(await legacyTmuxSessions(manager)).length,
    "the pane to die",
  );
  assert.equal((await manager.metadata("quiet")).status, "running", "not seen yet");
  await manager.create(shell("next", "Next", dataDir));
  assert.equal(manager.socketPath, sockets.produced);
  const quiet = await manager.metadata("quiet");
  assert.equal(quiet.status, "stopped");
  assert.equal(quiet.interruption, undefined, "an exit, not a lost server");
  assert.match(
    await readFile(path.join(dataDir, "sessions", "quiet.screen"), "utf8"),
    /BYE/,
  );
  await noServer(sockets.legacy);
});

test("a CLI that ended while AgentPier was stopped is recorded at startup", async (t) => {
  const { dataDir, sockets, manager, start } = await legacyServer(t, [["late", "Late"]]);
  await manager.close();
  await exec(tmuxPath, [
    "-S",
    sockets.legacy,
    "respawn-pane",
    "-k",
    "-t",
    "=agentpier-late:0.0",
    "echo GONE; exit 3",
  ]);
  await eventually(
    async () =>
      (
        await exec(tmuxPath, [
          "-S",
          sockets.legacy,
          "list-sessions",
          "-F",
          "#{pane_dead}",
        ])
      ).stdout.trim() === "1",
    "the pane to die",
  );
  const restarted = await start();
  assert.equal(restarted.socketPath, sockets.produced);
  const late = await restarted.metadata("late");
  assert.equal(late.status, "stopped");
  assert.equal(late.exitCode, 3);
  assert.equal(late.interruption, undefined, "not a lost server, so no auto-resume");
  assert.match(
    await readFile(path.join(dataDir, "sessions", "late.screen"), "utf8"),
    /GONE/,
  );
  await noServer(sockets.legacy);
});

test("a session without a stored record keeps the old server but is not listed", async (t) => {
  const { dataDir, sockets, manager } = await legacyServer(t, [["alpha", "Alpha"]]);
  await exec(tmuxPath, [
    "-S",
    sockets.legacy,
    "new-session",
    "-d",
    "-s",
    "agentpier-ghost",
    "sleep 60",
  ]);
  assert.deepEqual(await legacyTmuxSessions(manager), [{ id: "alpha", name: "Alpha" }]);
  await manager.stop("alpha");
  assert.deepEqual(await legacyTmuxSessions(manager), []);
  const logged = quietly(t);
  await manager.create(shell("next", "Next", dataDir));
  assert.equal(manager.socketPath, sockets.legacy, "never ends what is not ours");
  assert.deepEqual(await names(sockets.legacy), ["agentpier-ghost", "agentpier-next"]);
  assert.match(String(logged.mock.calls.at(-1).arguments[0]), /not AgentPier's/);
});

test("an unusable new socket folder keeps the old server", async (t) => {
  const { dataDir, sockets, manager } = await legacyServer(t, [["alpha", "Alpha"]]);
  await manager.stop("alpha");
  await writeFile(path.dirname(sockets.produced), "");
  const logged = quietly(t);
  await manager.create(shell("next", "Next", dataDir));
  assert.equal(manager.socketPath, sockets.legacy);
  assert.equal((await manager.get("next")).status, "running");
  assert.match(
    String(logged.mock.calls.at(-1).arguments[0]),
    /could not prepare the new tmux socket folder/,
  );
});
