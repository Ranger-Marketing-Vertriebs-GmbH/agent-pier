import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../server/lib/config.js";
import {
  newReleaseManifest,
  releaseManifest,
} from "../../server/features/operations/release-archive.js";
import {
  ALTERNATE_SESSION_PREFIX,
  chooseTmuxSocket,
  SESSION_PREFIX,
  ownedSocket,
  sessionIdFromName,
  tmuxServerAnswers,
  tmuxSocketPaths,
} from "../../server/features/sessions/tmux-naming.js";
import { sessionPanes } from "../../server/features/system-status/system-status.js";

const variables = [
  "AGENTPIER_DATA_DIR",
  "TUIUI_DATA_DIR",
  "AGENTPIER_PORT",
  "TUIUI_PORT",
  "AGENTPIER_DEV",
  "TUIUI_DEV",
];

function environment(t, values) {
  const saved = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  for (const key of variables) delete process.env[key];
  Object.assign(process.env, values);
}

test("the former TUIUI_* variables remain silent configuration fallbacks", (t) => {
  const legacy = mkdtempSync(path.join(tmpdir(), "agentpier-legacy-env-"));
  const current = mkdtempSync(path.join(tmpdir(), "agentpier-current-env-"));
  t.after(() => {
    rmSync(legacy, { recursive: true, force: true });
    rmSync(current, { recursive: true, force: true });
  });
  environment(t, { TUIUI_DATA_DIR: legacy, TUIUI_PORT: "4391", TUIUI_DEV: "1" });
  let config = loadConfig();
  assert.equal(config.dataDir, legacy);
  assert.equal(config.port, 4391);
  assert.equal(config.devOrigins.length, 2);

  Object.assign(process.env, {
    AGENTPIER_DATA_DIR: current,
    AGENTPIER_PORT: "4392",
    AGENTPIER_DEV: "0",
  });
  config = loadConfig();
  assert.equal(config.dataDir, current, "AGENTPIER_* wins");
  assert.equal(config.port, 4392);
  assert.deepEqual(config.devOrigins, []);
});

test("current and legacy tmux session names resolve to the same id", () => {
  assert.equal(sessionIdFromName("agentpier-abc_1"), "abc_1");
  assert.equal(sessionIdFromName("tuiui-abc_1"), "abc_1");
  for (const name of [
    "other",
    "agentpier-",
    "tuiui-../x",
    "xagentpier-a",
    "agentpier-a b",
  ])
    assert.equal(sessionIdFromName(name), null, name);
});

test("the legacy socket stays in use while its server answers, else the agentpier one", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentpier-socket-choice-"));
  const { produced, legacy } = tmuxSocketPaths(dataDir);
  const servers = [];
  t.after(() => {
    for (const server of servers) server.close();
    for (const socket of [produced, legacy])
      rmSync(path.dirname(socket), { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const listen = async (socket) => {
    mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
    const server = net.createServer();
    servers.push(server);
    await new Promise((resolve) => server.listen(socket, resolve));
  };
  const asked = [];
  const answering =
    (...sockets) =>
    (socket) => {
      asked.push(socket);
      return sockets.includes(socket);
    };
  assert.match(produced, /^\/tmp\/agentpier-[^/]+-[0-9a-f]{24}\/tmux\.sock$/);
  assert.match(legacy, /^\/tmp\/tuiui-[^/]+-[0-9a-f]{24}\/tmux\.sock$/);
  assert.equal(
    chooseTmuxSocket(dataDir, { answers: answering(produced, legacy) }),
    produced,
  );
  assert.deepEqual(asked, [], "no legacy socket file: nothing is asked");
  // A regular file in place of a socket is never ours, so it is never asked.
  mkdirSync(path.dirname(legacy), { mode: 0o700 });
  writeFileSync(legacy, "");
  assert.equal(chooseTmuxSocket(dataDir, { answers: answering(legacy) }), produced);
  assert.deepEqual(asked, []);
  rmSync(legacy);
  await listen(legacy);
  await listen(produced);
  assert.equal(
    chooseTmuxSocket(dataDir, { answers: answering(legacy) }),
    legacy,
    "sessions from before the update keep their server",
  );
  assert.equal(
    chooseTmuxSocket(dataDir, { answers: answering(produced, legacy) }),
    legacy,
    "both live: the legacy server keeps its sessions",
  );
  assert.equal(
    chooseTmuxSocket(dataDir, { answers: answering(produced) }),
    produced,
    "a stale legacy socket file is not used",
  );
  assert.equal(
    chooseTmuxSocket(dataDir, { answers: answering() }),
    produced,
    "none live",
  );
  // Someone else's socket is not ours either.
  const foreign = (file) => {
    const stat = lstatSync(file);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0 });
  };
  assert.equal(ownedSocket(legacy, { lstat: foreign, uid: 501 }), false);
  assert.equal(
    chooseTmuxSocket(dataDir, {
      lstat: foreign,
      uid: 501,
      answers: answering(legacy),
    }),
    produced,
  );
});

test("a probe that times out counts as a live server; a refused or failed one does not", () => {
  const probe = (result) => tmuxServerAnswers("/tmp/x.sock", { spawn: () => result });
  assert.equal(probe({ status: 0 }), true);
  assert.equal(
    probe({ status: null, error: Object.assign(new Error(), { code: "ETIMEDOUT" }) }),
    true,
  );
  assert.equal(probe({ status: 1 }), false);
  assert.equal(
    probe({ status: null, error: Object.assign(new Error(), { code: "ENOENT" }) }),
    false,
  );
});

test("system status counts both names and prefers a live pane, then the produced name", async () => {
  const panes = await sessionPanes({
    tmux: async () =>
      [
        "tuiui-old|0|101",
        "agentpier-new|0|201",
        "tuiui-both|0|301",
        "agentpier-both|0|302",
        "tuiui-revived|1|401",
        "agentpier-revived|0|402",
        "agentpier-gone|1|501",
        "tuiui-gone|1|502",
        "other|0|5",
      ].join("\n"),
    metadata: async () => ({ name: "", tool: "codex" }),
  });
  assert.deepEqual(
    panes.map(({ id, pid }) => [id, pid]),
    [
      ["old", 101],
      ["new", 201],
      ["both", 302],
      ["revived", 402],
      ["gone", 501],
    ],
  );
});

test("new sessions are named agentpier-<id>; tuiui-<id> stays understood", () => {
  assert.equal(SESSION_PREFIX, "agentpier-");
  assert.equal(ALTERNATE_SESSION_PREFIX, "tuiui-");
});

test("release manifests list every tmux name form this release understands", () => {
  const manifest = newReleaseManifest("9.9.9");
  assert.deepEqual([...manifest.tmuxNames].sort(), ["agentpier", "tuiui"]);
  assert.deepEqual(releaseManifest(manifest), manifest);
});
