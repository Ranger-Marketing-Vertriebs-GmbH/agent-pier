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
  chooseTmuxSocket,
  ownedSocket,
  sessionIdFromName,
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

test("the produced socket wins; a later release's socket is used only when alone", async (t) => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentpier-socket-choice-"));
  const { produced, alternate } = tmuxSocketPaths(dataDir);
  const servers = [];
  t.after(() => {
    for (const server of servers) server.close();
    for (const socket of [produced, alternate])
      rmSync(path.dirname(socket), { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });
  const listen = async (socket) => {
    mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
    const server = net.createServer();
    servers.push(server);
    await new Promise((resolve) => server.listen(socket, resolve));
  };
  assert.match(produced, /^\/tmp\/tuiui-[^/]+-[0-9a-f]{24}\/tmux\.sock$/);
  assert.match(alternate, /^\/tmp\/agentpier-[^/]+-[0-9a-f]{24}\/tmux\.sock$/);
  assert.equal(chooseTmuxSocket(dataDir), produced, "nothing running: produced socket");
  // A regular file in place of a socket is never ours.
  mkdirSync(path.dirname(alternate), { mode: 0o700 });
  writeFileSync(alternate, "");
  assert.equal(chooseTmuxSocket(dataDir), produced);
  rmSync(alternate);
  await listen(alternate);
  assert.equal(chooseTmuxSocket(dataDir), alternate, "rolled back from a later release");
  // Someone else's socket is not ours either.
  const foreign = (file) => {
    const stat = lstatSync(file);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0 });
  };
  assert.equal(ownedSocket(alternate, { lstat: foreign, uid: 501 }), false);
  assert.equal(chooseTmuxSocket(dataDir, { lstat: foreign, uid: 501 }), produced);
  await listen(produced);
  assert.equal(chooseTmuxSocket(dataDir), produced, "both running: produced wins");
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
      ["both", 301],
      ["revived", 402],
      ["gone", 502],
    ],
  );
});

test("release manifests list every tmux name form this release understands", () => {
  const manifest = newReleaseManifest("9.9.9");
  assert.deepEqual(manifest.tmuxNames, ["tuiui", "agentpier"]);
  assert.deepEqual(releaseManifest(manifest), manifest);
});
