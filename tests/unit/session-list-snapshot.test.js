import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { resolveCommand } from "../../server/features/sessions/session-process-runtime.js";
import { snapshotConfirms } from "../../server/features/sessions/tmux-pane-state.js";

// Models tmux at the subprocess boundary: `panes` maps a session id to its pane state.
async function fixture(t, sessions) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-list-snapshot-"));
  const stopped = [];
  const manager = new SessionManager({
    dataDir,
    onStopped: (session) => stopped.push(session.id),
  });
  await manager.ready;
  const panes = new Map();
  for (const [index, { pane, ...session }] of sessions.entries()) {
    await manager.save({ createdAt: `2026-01-0${index + 1}`, ...session });
    if (pane) panes.set(session.id, pane);
  }
  const calls = [];
  const tmux = { gone: false, snapshotFails: false };
  t.mock.method(manager, "tmux", async (args) => {
    calls.push(args);
    if (tmux.gone) throw new Error("no server running on /tmp/socket");
    if (args[0] === "capture-pane") return "BYE\n";
    if (args[0] === "list-sessions") return "4242|1700000000\n";
    assert.equal(args[0], "list-panes");
    if (args[1] === "-a") {
      await tmux.hold?.();
      if (tmux.snapshotFails) throw new Error("permission denied");
      return [...panes]
        .map(([id, state]) => `agentpier-${id}|1|${state}\nagentpier-${id}|0|1|9|`)
        .join("\n");
    }
    const id = args[2].slice("=agentpier-".length, -1);
    if (!panes.has(id)) throw new Error(`can't find session: ${id}`);
    return `${panes.get(id)}\n`;
  });
  t.after(async () => {
    await manager.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  const single = () =>
    calls.filter((args) => args[0] === "list-panes" && args[1] === "-t");
  return { manager, panes, calls, tmux, stopped, single };
}

const sessions = [
  { id: "alive", status: "running", pane: "0||" },
  ...Array.from({ length: 5 }, (_, index) => ({ id: `old-${index}`, status: "stopped" })),
  { id: "exited", status: "stopped", exitCode: 3, pane: "1|3|" },
];

test("a session list reads tmux once when every stored status is confirmed", async (t) => {
  const { manager, calls, single } = await fixture(t, sessions);
  const listed = await manager.list();
  assert.deepEqual(
    listed.map((session) => [session.id, session.status]),
    sessions.map((session) => [session.id, session.status]),
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["list-panes", "-a"]);
  assert.deepEqual(single(), []);
});

test("a snapshot that disagrees with stored metadata is read again under the lock", async (t) => {
  const { manager, panes, stopped, single } = await fixture(t, sessions);
  panes.set("alive", "1|0|");
  panes.set("old-2", "0||");
  const listed = new Map((await manager.list()).map((session) => [session.id, session]));
  assert.equal(listed.get("alive").status, "stopped");
  assert.equal(listed.get("alive").exitCode, 0);
  assert.equal(listed.get("old-2").status, "running");
  assert.deepEqual(
    single()
      .map((args) => args[2])
      .sort(),
    ["=agentpier-alive:", "=agentpier-old-2:"],
  );
  assert.ok(stopped.includes("alive"));
  assert.equal((await manager.metadata("alive")).status, "stopped");
});

test("a lost tmux server still marks running sessions interrupted", async (t) => {
  const { manager, tmux, single } = await fixture(t, sessions);
  tmux.gone = true;
  const listed = new Map((await manager.list()).map((session) => [session.id, session]));
  assert.equal(listed.get("alive").status, "stopped");
  assert.equal(listed.get("alive").interruption?.cause, "tmux-server-lost");
  assert.deepEqual(
    single().map((args) => args[2]),
    ["=agentpier-alive:"],
  );
});

test("a failing snapshot falls back to one read per session", async (t) => {
  const { manager, tmux, single } = await fixture(t, sessions);
  tmux.snapshotFails = true;
  assert.equal((await manager.list()).length, sessions.length);
  assert.equal(single().length, sessions.length);
});

test("concurrent lists share the next list and never see one started before them", async (t) => {
  const { manager, calls, tmux } = await fixture(t, sessions);
  const snapshots = () => calls.filter((args) => args[1] === "-a").length;
  let release;
  const started = new Promise((resolve) => {
    tmux.hold = () => {
      tmux.hold = undefined;
      resolve();
      return new Promise((done) => (release = done));
    };
  });
  // Callers in the same turn join the list that has not started yet.
  const first = [manager.list(), manager.list()];
  await started;
  // A list already reading tmux may miss a change; later callers wait for the next.
  const joined = [manager.list(), manager.list(), manager.list()];
  release();
  const lists = await Promise.all([...first, ...joined]);
  assert.equal(snapshots(), 2);
  assert.equal(lists.length, 5);
  assert.notEqual(lists[1], lists[2]);
  lists[1][0].name = "mutated";
  assert.notEqual(lists[2][0].name, "mutated");
  await manager.list();
  assert.equal(calls.filter((args) => args[1] === "-a").length, 3);
});

test("only a confirming snapshot skips the live read", () => {
  assert.equal(snapshotConfirms({ status: "running" }, "0||"), true);
  assert.equal(snapshotConfirms({ status: "stopped" }, null), true);
  assert.equal(snapshotConfirms({ status: "stopped", exitCode: 1 }, "1|1|"), true);
  assert.equal(snapshotConfirms({ status: "stopped", exitCode: 1 }, "1|2|"), false);
  assert.equal(snapshotConfirms({ status: "running" }, "1||"), false);
  assert.equal(snapshotConfirms({ status: "running" }, null), false);
  assert.equal(
    snapshotConfirms({ status: "running", interruption: { cause: "x" } }, "0||"),
    false,
  );
});

test("a bare command resolves once to its absolute executable on PATH", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "agentpier-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [empty, bin] = [path.join(root, "empty"), path.join(root, "bin")];
  await mkdir(empty);
  await mkdir(bin);
  await mkdir(path.join(empty, "fake-tmux"));
  await writeFile(path.join(bin, "fake-tmux"), "#!/bin/sh\n");
  await chmod(path.join(bin, "fake-tmux"), 0o755);
  const searchPath = ["relative", empty, bin].join(path.delimiter);
  assert.equal(resolveCommand("fake-tmux", searchPath), path.join(bin, "fake-tmux"));
  assert.equal(resolveCommand("missing-tmux", searchPath), "missing-tmux");
  assert.equal(resolveCommand("/opt/tmux", searchPath), "/opt/tmux");
});
