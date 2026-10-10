import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

async function fixture(t, initial = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-interruption-"));
  const manager = new SessionManager({ dataDir });
  const interrupted = [];
  manager.onInterrupted = (session) => interrupted.push(session.id);
  await manager.ready;
  await manager.save({
    id: "owned-fixture",
    status: "running",
    createdAt: "2026-10-10T00:00:00.000Z",
    ...initial,
  });
  // Model tmux at the subprocess boundary; no native server is started.
  const tmux = {
    panes: "0||",
    paneError: null,
    server: "100|1700000000",
    serverError: null,
  };
  t.mock.method(manager, "tmux", async (args) => {
    if (args[0] === "list-sessions") {
      if (tmux.serverError) throw new Error(tmux.serverError);
      return tmux.server + "\n";
    }
    if (["capture-pane", "kill-session", "run-shell"].includes(args[0])) return "";
    assert.equal(args[0], "list-panes");
    if (tmux.paneError) throw new Error(tmux.paneError);
    return tmux.panes + "\n";
  });
  t.after(async () => {
    await manager.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { manager, tmux, interrupted, settle, read: () => manager.get("owned-fixture") };
}

test("an unreachable tmux server marks a running session as interrupted", async (t) => {
  const { tmux, interrupted, settle, read } = await fixture(t);
  tmux.paneError = "no server running on /tmp/tuiui-501-x/tmux.sock";
  const session = await read();
  assert.equal(session.status, "stopped");
  assert.equal(session.interruption.cause, "tmux-server-lost");
  assert.equal(session.interruption.resume, "pending");
  assert.ok(!Number.isNaN(Date.parse(session.interruption.at)));
  await settle();
  assert.deepEqual(interrupted, ["owned-fixture"]);
  await read();
  await settle();
  assert.deepEqual(interrupted, ["owned-fixture"]);
});

test("a missing session on a replaced tmux server is an interruption", async (t) => {
  const { tmux, read } = await fixture(t, {
    tmuxServer: { pid: 100, startTime: 1700000000 },
  });
  tmux.paneError = "can't find session: tuiui-owned-fixture";
  tmux.server = "100|1790000000"; // Same pid after a reboot, new start time.
  assert.equal((await read()).interruption?.resume, "pending");
});

test("a missing session on the same tmux server is no interruption", async (t) => {
  const { tmux, interrupted, settle, read } = await fixture(t, {
    tmuxServer: { pid: 100, startTime: 1700000000 },
  });
  tmux.paneError = "can't find session: tuiui-owned-fixture";
  const session = await read();
  assert.equal(session.status, "stopped");
  assert.equal(session.interruption, undefined);
  await settle();
  assert.deepEqual(interrupted, []);
});

test("dead pane exit is no interruption", async (t) => {
  const { tmux, read } = await fixture(t);
  tmux.panes = "1|0|";
  const session = await read();
  assert.equal(session.status, "stopped");
  assert.equal(session.interruption, undefined);
});

test("interruption callback runs after the lock is released", async (t) => {
  const { manager, tmux, read } = await fixture(t);
  let reread;
  manager.onInterrupted = (session) => {
    reread = manager.get(session.id); // Would deadlock if called inside the lock.
  };
  tmux.paneError = "no server running";
  await read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await reread).interruption.resume, "pending");
});

test("a user stop clears the interruption and setInterruption persists changes", async (t) => {
  const { manager, read } = await fixture(t);
  await manager.setInterruption("owned-fixture", {
    cause: "tmux-server-lost",
    at: "2026-10-10T00:00:00.000Z",
    resume: "failed",
    reason: "timeout",
  });
  assert.equal((await manager.metadata("owned-fixture")).interruption.reason, "timeout");
  await manager.stop("owned-fixture");
  assert.equal((await read()).interruption, undefined);
  await manager.setInterruption("owned-fixture", null);
  assert.equal((await manager.metadata("owned-fixture")).interruption, undefined);
});

test("a live server without sessions is no interruption", async (t) => {
  const { tmux, interrupted, settle, read } = await fixture(t, {
    tmuxServer: { pid: 100, startTime: 1700000000 },
  });
  tmux.paneError = "can't find session: tuiui-owned-fixture";
  tmux.server = ""; // exit-empty off: the server answers with no output.
  const session = await read();
  assert.equal(session.status, "stopped");
  assert.equal(session.interruption, undefined);
  await settle();
  assert.deepEqual(interrupted, []);
});

test("a failing identity probe is no interruption", async (t) => {
  const { tmux, interrupted, settle, read } = await fixture(t, {
    tmuxServer: { pid: 100, startTime: 1700000000 },
  });
  tmux.paneError = "can't find session: tuiui-owned-fixture";
  tmux.serverError = "permission denied";
  const session = await read();
  assert.equal(session.interruption, undefined);
  await settle();
  assert.deepEqual(interrupted, []);
});
