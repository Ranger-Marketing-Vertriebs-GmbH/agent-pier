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
  ownedSocket,
  tmuxSocketPaths,
} from "../../server/features/sessions/tmux-naming.js";
import { scanSessionNames } from "../../server/features/sessions/session-names.js";
import { sessionPanes } from "../../server/features/system-status/system-status.js";

const exec = promisify(execFile);
const tmuxPath = process.env.TMUX_PATH || "tmux";

async function eventually(fn, message, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.fail(`Timed out waiting for ${message}`);
}

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

const paneDead = (socket, name) =>
  eventually(
    async () =>
      (
        await exec(tmuxPath, [
          "-S",
          socket,
          "display-message",
          "-p",
          "-t",
          `=${name}:0.0`,
          "#{pane_dead}",
        ])
      ).stdout.trim() === "1",
    `${name} exit`,
  );

const shell = (extra) => ({
  name: "Fixture",
  tool: "codex",
  accountId: "fixture-account",
  command: "/bin/sh",
  args: [
    "-c",
    'echo READY; while IFS= read -r line; do printf "REPLY:%s\\n" "$line"; done',
  ],
  env: { PATH: "/usr/bin:/bin" },
  ...extra,
});

/**
 * Reproduces a rollback from a later release that names sessions `agentpier-<id>`: its
 * tmux server outlived the service restart and still runs such a session, either on
 * that release's own socket (`alternate`) or on this release's socket (`produced`).
 */
async function laterRelease(t, { socket = "alternate", launch = {} } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-name-forms-"));
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
  const server = sockets[socket];
  await mkdir(path.dirname(server), { mode: 0o700 });
  await exec(tmuxPath, [
    "-S",
    server,
    "-f",
    "/dev/null",
    "new-session",
    "-d",
    "-s",
    "boot",
  ]);
  const start = () => {
    const manager = new SessionManager({ dataDir, tmuxPath });
    managers.push(manager);
    return manager;
  };
  const previous = start();
  assert.equal(previous.socketPath, server);
  await previous.ready;
  await previous.tmux(["source-file", previous.configPath]);
  const later = await previous.create(
    shell({ id: "later-one", cwd: dataDir, ...launch }),
  );
  await exec(tmuxPath, [
    "-S",
    server,
    "rename-session",
    "-t",
    `=tuiui-${later.id}`,
    `agentpier-${later.id}`,
  ]);
  await exec(tmuxPath, ["-S", server, "kill-session", "-t", "=boot"]);
  await previous.close();
  return { dataDir, server, id: later.id, start };
}

test("new sessions keep the tuiui name on the tuiui socket", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-produced-names-"));
  const { produced } = tmuxSocketPaths(dataDir);
  const manager = new SessionManager({ dataDir, tmuxPath });
  t.after(async () => {
    await manager.close();
    await exec(tmuxPath, ["-S", produced, "kill-server"]).catch(() => {});
    await rm(path.dirname(produced), { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(manager.socketPath, produced);
  const created = await manager.create(shell({ id: "new-one", cwd: dataDir }));
  assert.equal(manager.target(created.id), `=tuiui-${created.id}`);
  assert.deepEqual(await names(produced), [`tuiui-${created.id}`]);
});

for (const socket of ["alternate", "produced"])
  test(`a rollback keeps agentpier sessions operable on the ${socket} socket`, async (t) => {
    const { dataDir, server, id, start } = await laterRelease(t, { socket });
    const manager = start();
    await manager.ready;
    assert.equal(manager.socketPath, server);
    assert.equal(manager.target(id), `=agentpier-${id}`);
    assert.equal((await manager.get(id)).status, "running");
    await eventually(async () => (await manager.screen(id)).includes("READY"), "replay");
    await manager.input(id, "after rollback", true);
    await eventually(
      async () => (await manager.screen(id)).includes("REPLY:after rollback"),
      "input to the agentpier session",
    );
    let replay = "";
    const client = await manager.attach(id, {
      cols: 90,
      rows: 30,
      onData: (data) => (replay += data),
    });
    await eventually(() => replay.includes("REPLY:after rollback"), "attach replay");
    client.dispose();
    assert.deepEqual(
      (await sessionPanes(manager)).map((pane) => pane.id),
      [id],
    );

    const created = await manager.create(shell({ id: "fresh-one", cwd: dataDir }));
    assert.deepEqual(await names(server), [`agentpier-${id}`, `tuiui-${created.id}`]);
    assert.deepEqual(
      (await manager.list()).map((session) => [session.id, session.status]),
      [
        [id, "running"],
        [created.id, "running"],
      ],
    );
    await manager.stop(id);
    assert.deepEqual(await names(server), [`tuiui-${created.id}`]);
    assert.equal((await manager.get(id)).status, "stopped");
  });

test("startup picks the socket whose tmux server answers, not the one whose file exists", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-socket-liveness-"));
  const { produced, alternate } = tmuxSocketPaths(dataDir);
  t.after(async () => {
    for (const file of [produced, alternate]) {
      await exec(tmuxPath, ["-S", file, "kill-server"]).catch(() => {});
      await rm(path.dirname(file), { recursive: true, force: true });
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const serve = async (socket) => {
    await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
    await exec(tmuxPath, [
      "-S",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "sleep 60",
    ]);
  };
  const stop = (socket) => exec(tmuxPath, ["-S", socket, "kill-server"]);
  const choose = () => chooseTmuxSocket(dataDir, { tmuxPath });
  await serve(produced);
  await serve(alternate);
  assert.equal(choose(), produced, "both live: the produced socket wins");
  await stop(produced);
  assert.ok(ownedSocket(produced), "tmux leaves its socket file behind");
  assert.equal(choose(), alternate, "a stale produced file next to a live later server");
  await stop(alternate);
  assert.equal(choose(), produced, "none live");
});

test("a session missed by the startup scan is still found under its other name", async (t) => {
  const { id, start } = await laterRelease(t);
  const manager = start();
  await manager.ready;
  manager.alternateSessions.clear();
  assert.equal((await manager.get(id)).status, "running");
  assert.equal(manager.target(id), `=agentpier-${id}`);
});

test("a replacement relaunches under the tuiui name only", async (t) => {
  const { server, id, start } = await laterRelease(t);
  const manager = start();
  await manager.updateReload(id, { state: "reloading", nativeId: "fixture-native" });
  const result = await manager.replace(id, async () => ({
    command: "/bin/sh",
    args: ["-c", "echo REPLACED; sleep 60"],
    env: {},
  }));
  assert.equal(result.status, "running");
  assert.equal(manager.target(id), `=tuiui-${id}`);
  assert.deepEqual(await names(server), [`tuiui-${id}`]);
  await eventually(
    async () => (await manager.screen(id)).includes("REPLACED"),
    "relaunch",
  );
});

for (const operation of ["stop", "remove", "replace"])
  test(`${operation} leaves no dead pane under the other name`, async (t) => {
    const { server, id, start } = await laterRelease(t, {
      launch: { args: ["-c", "echo DONE"] },
    });
    const manager = start();
    await manager.ready;
    await paneDead(server, `agentpier-${id}`);
    // The recorded exit; this start missed the dead pane.
    await manager.save({ ...(await manager.metadata(id)), status: "stopped" });
    manager.alternateSessions.clear();
    if (operation === "stop") await manager.stop(id);
    if (operation === "remove") await manager.remove(id);
    if (operation === "replace") {
      await manager.updateReload(id, { state: "reloading", nativeId: "fixture" });
      await manager.replace(id, async () => ({
        command: "/bin/sh",
        args: ["-c", "sleep 60"],
        env: {},
      }));
    }
    assert.deepEqual(await names(server), operation === "replace" ? [`tuiui-${id}`] : []);
  });

test("a dead pane never shadows a live one under the other name", async (t) => {
  const { server, id, start } = await laterRelease(t);
  // A dead tuiui-<id> beside the live agentpier-<id>, e.g. from an older relaunch.
  await exec(tmuxPath, ["-S", server, "new-session", "-d", "-s", `tuiui-${id}`, "true"]);
  await paneDead(server, `tuiui-${id}`);
  const manager = start();
  await manager.ready;
  assert.equal(manager.target(id), `=agentpier-${id}`, "the startup scan prefers live");
  assert.equal((await manager.get(id)).status, "running");
  assert.deepEqual(
    (await sessionPanes(manager)).map((pane) => pane.id),
    [id],
  );
  // Without the scan, the dead produced pane still leads to the live one.
  manager.alternateSessions.clear();
  assert.equal((await manager.get(id)).status, "running");
  assert.equal(manager.target(id), `=agentpier-${id}`);
  await manager.input(id, "still here", true);
  await eventually(
    async () => (await manager.screen(id)).includes("REPLY:still here"),
    "input reaches the live session",
  );
  await manager.stop(id);
  assert.deepEqual(await names(server), [], "stop ends both names");
});

test("an unanswered probe keeps the recorded state and leaves a trace", async (t) => {
  const { id, start } = await laterRelease(t);
  const manager = start();
  await manager.ready;
  manager.alternateSessions.clear();
  await manager.tmux(["rename-session", "-t", `=agentpier-${id}`, `hidden-${id}`]);
  const tmux = manager.tmux.bind(manager);
  t.mock.method(manager, "tmux", async (args, options) => {
    if (args[0] === "list-panes" && args[2].startsWith("=agentpier-"))
      throw new Error("tmux: out of memory");
    return tmux(args, options);
  });
  const logged = t.mock.method(console, "error", () => {});
  assert.equal((await manager.get(id)).status, "running", "no evidence of a stop");
  assert.equal((await manager.metadata(id)).status, "running");
  assert.equal(logged.mock.callCount(), 1);
  assert.match(logged.mock.calls[0].arguments[0], /out of memory/);
});

test("the startup scan traces failures other than a missing server", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const manager = (error) => ({
    alternateSessions: new Set(),
    tmux: async () => {
      throw new Error(error);
    },
  });
  await scanSessionNames(manager("no server running on /tmp/x"));
  assert.equal(logged.mock.callCount(), 0);
  await scanSessionNames(manager("permission denied\nsecond line"));
  assert.equal(logged.mock.callCount(), 1);
  assert.equal(
    logged.mock.calls[0].arguments[0],
    "AgentPier could not list tmux sessions at startup: permission denied",
  );
});
