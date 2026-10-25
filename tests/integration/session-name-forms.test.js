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
 * Reproduces an update from the release before this one, which named sessions
 * `tuiui-<id>`: its tmux server outlived the service restart and still runs such a
 * session, either on the legacy socket (`legacy`, every update from it) or on this
 * release's socket (`produced`, when it ran there after a rollback from this release).
 */
async function earlierRelease(
  t,
  { socket = "legacy", launch = {}, keeper = false } = {},
) {
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
    // A session of the earlier release keeps its server in use while it starts.
    "tuiui-boot",
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
  const earlier = await previous.create(
    shell({ id: "earlier-one", cwd: dataDir, ...launch }),
  );
  await exec(tmuxPath, [
    "-S",
    server,
    "rename-session",
    "-t",
    `=agentpier-${earlier.id}`,
    `tuiui-${earlier.id}`,
  ]);
  // A keeper is another live session there, so the server stays in use after this one.
  await exec(
    tmuxPath,
    keeper
      ? ["-S", server, "rename-session", "-t", "=tuiui-boot", "agentpier-keeper"]
      : ["-S", server, "kill-session", "-t", "=tuiui-boot"],
  );
  await previous.close();
  return { dataDir, server, id: earlier.id, start };
}

test("new sessions get the agentpier name on the agentpier socket", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-produced-names-"));
  const { produced } = tmuxSocketPaths(dataDir);
  const manager = new SessionManager({ dataDir, tmuxPath });
  t.after(async () => {
    await manager.close();
    await exec(tmuxPath, ["-S", produced, "kill-server"]).catch(() => {});
    await rm(path.dirname(produced), { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.match(produced, /\/tmp\/agentpier-[^/]+\/tmux\.sock$/);
  assert.equal(manager.socketPath, produced);
  const created = await manager.create(shell({ id: "new-one", cwd: dataDir }));
  assert.equal(manager.target(created.id), `=agentpier-${created.id}`);
  assert.deepEqual(await names(produced), [`agentpier-${created.id}`]);
});

for (const socket of ["legacy", "produced"])
  test(`after an update tuiui sessions stay operable on the ${socket} socket`, async (t) => {
    const { dataDir, server, id, start } = await earlierRelease(t, { socket });
    const manager = start();
    await manager.ready;
    assert.equal(manager.socketPath, server);
    assert.equal(manager.target(id), `=tuiui-${id}`);
    assert.equal((await manager.get(id)).status, "running");
    await eventually(async () => (await manager.screen(id)).includes("READY"), "replay");
    await manager.input(id, "after update", true);
    await eventually(
      async () => (await manager.screen(id)).includes("REPLY:after update"),
      "input to the tuiui session",
    );
    let replay = "";
    const client = await manager.attach(id, {
      cols: 90,
      rows: 30,
      onData: (data) => (replay += data),
    });
    await eventually(() => replay.includes("REPLY:after update"), "attach replay");
    client.dispose();
    assert.deepEqual(
      (await sessionPanes(manager)).map((pane) => pane.id),
      [id],
    );

    // New sessions join the same server under the new name.
    const created = await manager.create(shell({ id: "fresh-one", cwd: dataDir }));
    assert.deepEqual(await names(server), [`agentpier-${created.id}`, `tuiui-${id}`]);
    assert.deepEqual(
      (await manager.list()).map((session) => [session.id, session.status]),
      [
        [id, "running"],
        [created.id, "running"],
      ],
    );
    await manager.stop(id);
    assert.deepEqual(await names(server), [`agentpier-${created.id}`]);
    assert.equal((await manager.get(id)).status, "stopped");
  });

test("startup prefers a live agentpier server, then any legacy server", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-socket-liveness-"));
  const { produced, legacy } = tmuxSocketPaths(dataDir);
  t.after(async () => {
    for (const file of [produced, legacy]) {
      await exec(tmuxPath, ["-S", file, "kill-server"]).catch(() => {});
      await rm(path.dirname(file), { recursive: true, force: true });
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  const serve = async (socket, name = "agentpier-fixture", command = "sleep 60") => {
    await mkdir(path.dirname(socket), { recursive: true, mode: 0o700 });
    await exec(tmuxPath, [
      "-S",
      socket,
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      name,
      command,
    ]);
  };
  const stop = (socket) => exec(tmuxPath, ["-S", socket, "kill-server"]);
  const choose = () => chooseTmuxSocket(dataDir, { tmuxPath });
  // Any legacy server is taken, so that startup can end it once it is drained.
  await serve(legacy, "other");
  assert.equal(choose(), legacy, "another program's session only");
  await serve(produced, "agentpier-idle");
  await exec(tmuxPath, ["-S", produced, "set-option", "-g", "remain-on-exit", "on"]);
  await exec(tmuxPath, [
    "-S",
    produced,
    "respawn-pane",
    "-k",
    "-t",
    "=agentpier-idle:0.0",
    "true",
  ]);
  await paneDead(produced, "agentpier-idle");
  assert.equal(choose(), legacy, "an agentpier server without a live session");
  await stop(produced);
  await serve(produced);
  assert.equal(choose(), produced, "a live agentpier session wins");
  await stop(produced);
  await stop(legacy);
  await serve(legacy);
  assert.equal(choose(), legacy, "the server from before the update keeps running");
  await stop(legacy);
  assert.ok(ownedSocket(legacy), "tmux leaves its socket file behind");
  assert.equal(choose(), produced, "a stale legacy file is not used");
  assert.equal(choose(), produced, "none live");
});

test("a session missed by the startup scan is still found under its other name", async (t) => {
  const { id, start } = await earlierRelease(t);
  const manager = start();
  await manager.ready;
  manager.alternateSessions.clear();
  assert.equal((await manager.get(id)).status, "running");
  assert.equal(manager.target(id), `=tuiui-${id}`);
});

test("a replacement relaunches under the agentpier name only", async (t) => {
  const { server, id, start } = await earlierRelease(t, { keeper: true });
  const manager = start();
  await manager.updateReload(id, { state: "reloading", nativeId: "fixture-native" });
  const result = await manager.replace(id, async () => ({
    command: "/bin/sh",
    args: ["-c", "echo REPLACED; sleep 60"],
    env: {},
  }));
  assert.equal(result.status, "running");
  assert.equal(manager.target(id), `=agentpier-${id}`);
  assert.deepEqual(await names(server), [`agentpier-${id}`, "agentpier-keeper"]);
  await eventually(
    async () => (await manager.screen(id)).includes("REPLACED"),
    "relaunch",
  );
});

for (const operation of ["stop", "remove", "replace"])
  test(`${operation} leaves no dead pane under the other name`, async (t) => {
    const { server, id, start } = await earlierRelease(t, {
      launch: { args: ["-c", "echo DONE"] },
      keeper: true,
    });
    const manager = start();
    await manager.ready;
    await paneDead(server, `tuiui-${id}`);
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
    assert.deepEqual(
      await names(server),
      operation === "replace"
        ? [`agentpier-${id}`, "agentpier-keeper"]
        : ["agentpier-keeper"],
    );
  });

test("a dead pane never shadows a live one under the other name", async (t) => {
  const { server, id, start } = await earlierRelease(t);
  // A dead agentpier-<id> beside the live tuiui-<id>, e.g. from an earlier relaunch.
  await exec(tmuxPath, [
    "-S",
    server,
    "new-session",
    "-d",
    "-s",
    `agentpier-${id}`,
    "true",
  ]);
  await paneDead(server, `agentpier-${id}`);
  const manager = start();
  await manager.ready;
  assert.equal(manager.target(id), `=tuiui-${id}`, "the startup scan prefers live");
  assert.equal((await manager.get(id)).status, "running");
  assert.deepEqual(
    (await sessionPanes(manager)).map((pane) => pane.id),
    [id],
  );
  // Without the scan, the dead produced pane still leads to the live one.
  manager.alternateSessions.clear();
  assert.equal((await manager.get(id)).status, "running");
  assert.equal(manager.target(id), `=tuiui-${id}`);
  await manager.input(id, "still here", true);
  await eventually(
    async () => (await manager.screen(id)).includes("REPLY:still here"),
    "input reaches the live session",
  );
  await manager.stop(id);
  assert.deepEqual(await names(server), [], "stop ends both names");
});

test("an unanswered probe keeps the recorded state and leaves a trace", async (t) => {
  const { id, start } = await earlierRelease(t);
  const manager = start();
  await manager.ready;
  manager.alternateSessions.clear();
  await manager.tmux(["rename-session", "-t", `=tuiui-${id}`, `hidden-${id}`]);
  const tmux = manager.tmux.bind(manager);
  t.mock.method(manager, "tmux", async (args, options) => {
    if (args[0] === "list-panes" && args[2].startsWith("=tuiui-"))
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
