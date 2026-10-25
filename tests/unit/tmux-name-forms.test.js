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
  probeTmuxServer,
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

test("the socket choice prefers a live agentpier server, then any legacy server", async (t) => {
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
  // Each socket answers as given: "live", "answers" (no live AgentPier pane) or nothing.
  const probing = (states) => (socket) => {
    asked.push(socket);
    const state = states[socket === produced ? "produced" : "legacy"];
    return { answers: !!state, live: state === "live" };
  };
  const choose = (states, options = {}) =>
    chooseTmuxSocket(dataDir, { probe: probing(states), ...options });
  assert.match(produced, /^\/tmp\/agentpier-[^/]+-[0-9a-f]{24}\/tmux\.sock$/);
  assert.match(legacy, /^\/tmp\/tuiui-[^/]+-[0-9a-f]{24}\/tmux\.sock$/);
  assert.equal(choose({ produced: "live", legacy: "live" }), produced);
  assert.deepEqual(asked, [], "no socket file: nothing is asked");
  // A regular file in place of a socket is never ours, so it is never asked.
  mkdirSync(path.dirname(legacy), { mode: 0o700 });
  writeFileSync(legacy, "");
  assert.equal(choose({ legacy: "live" }), produced);
  assert.deepEqual(asked, []);
  rmSync(legacy);
  await listen(legacy);
  await listen(produced);
  assert.equal(
    choose({ legacy: "live" }),
    legacy,
    "sessions from before the update keep their server",
  );
  assert.equal(
    choose({ legacy: "answers" }),
    legacy,
    "a drained legacy server is taken, so startup can end it",
  );
  assert.equal(
    choose({ produced: "answers", legacy: "answers" }),
    legacy,
    "an agentpier server without a live session does not win",
  );
  // A probe that times out counts as live; the agentpier side still wins.
  assert.equal(choose({ produced: "live", legacy: "live" }), produced, "both live");
  assert.equal(choose({ produced: "live" }), produced, "a stale legacy socket file");
  assert.equal(choose({}), produced, "none answers");
  // A real probe whose legacy side times out never wins over a live agentpier session.
  const timedOut = {
    status: null,
    error: Object.assign(new Error(), { code: "ETIMEDOUT" }),
  };
  const spawn = (_tmux, args) =>
    args[1] === legacy
      ? timedOut
      : {
          status: 0,
          stdout: args[2] === "list-sessions" ? "agentpier-one\n" : "agentpier-one|0\n",
        };
  assert.equal(chooseTmuxSocket(dataDir, { spawn }), produced);
  assert.equal(
    chooseTmuxSocket(dataDir, {
      spawn: (_tmux, args) => (args[1] === legacy ? timedOut : { status: 1 }),
    }),
    legacy,
    "a slow legacy server keeps its sessions",
  );
  // Someone else's socket is not ours either.
  const foreign = (file) => {
    const stat = lstatSync(file);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: 0 });
  };
  assert.equal(ownedSocket(legacy, { lstat: foreign, uid: 501 }), false);
  assert.equal(choose({ legacy: "live" }, { lstat: foreign, uid: 501 }), produced);
});

test("a probe tells a running server from any live AgentPier pane; a timeout is both", () => {
  const timedOut = {
    status: null,
    error: Object.assign(new Error(), { code: "ETIMEDOUT" }),
  };
  // `panes` answers list-panes -a; a string stands for a successful answer.
  const probe = (sessions, panes) =>
    probeTmuxServer("/tmp/x.sock", {
      spawn: (_tmux, args) => {
        const answer = args[2] === "list-sessions" ? sessions : panes;
        return typeof answer === "string" ? { status: 0, stdout: answer } : answer;
      },
    });
  const yes = { answers: true, live: true };
  const idle = { answers: true, live: false };
  const none = { answers: false, live: false };
  assert.deepEqual(probe("agentpier-one\n", "agentpier-one|0\n"), yes);
  assert.deepEqual(probe("tuiui-one\n", "tuiui-one|0\n"), yes);
  // A dead active pane beside a live window or split still runs a process.
  assert.deepEqual(probe("agentpier-one\n", "agentpier-one|1\nagentpier-one|0\n"), yes);
  assert.deepEqual(probe(timedOut), yes);
  assert.deepEqual(probe("agentpier-one\n", timedOut), yes);
  assert.deepEqual(probe("agentpier-one\n", { status: 1 }), yes, "unclear: keep it");
  // exit-empty off keeps a server without sessions or with dead panes only running.
  assert.deepEqual(probe("", { status: 1 }), idle, "list-panes -a fails when empty");
  assert.deepEqual(
    probe("agentpier-one\ntuiui-two\n", "agentpier-one|1\ntuiui-two|1\n"),
    idle,
  );
  assert.deepEqual(probe("boot\n", "boot|0\n"), idle, "not AgentPier's");
  assert.deepEqual(probe({ status: 1, stdout: "" }), none);
  assert.deepEqual(
    probe({ status: null, error: Object.assign(new Error(), { code: "ENOENT" }) }),
    none,
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
