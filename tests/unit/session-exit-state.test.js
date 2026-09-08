import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

async function fixture(t, initial = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "agentpier-exit-state-"));
  const stopped = [];
  const manager = new SessionManager({
    dataDir,
    onStopped: (session) => stopped.push(session.id),
  });
  await manager.ready;
  await manager.save({ id: "owned-fixture", status: "running", ...initial });
  // Model tmux's format fields at the subprocess boundary; no native pane is opened.
  const native = { pane_dead: "0", pane_dead_status: "", pane_dead_signal: "" };
  const reapRequests = [];
  t.mock.method(manager, "tmux", async (args) => {
    if (native.missing) throw new Error("can't find pane: owned-fixture");
    if (args[0] === "run-shell") {
      assert.deepEqual(args, ["run-shell", "-t", "=tuiui-owned-fixture:0.0", ":"]);
      reapRequests.push(args);
      native.afterReap?.();
      return "";
    }
    if (args[0] === "capture-pane") return "GOODBYE\n";
    assert.equal(args[0], "list-panes");
    return args.at(-1).replace(/#\{(\w+)\}/g, (_match, key) => native[key] ?? "") + "\n";
  });
  t.after(async () => {
    await manager.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  return {
    manager,
    native,
    stopped,
    reapRequests,
    read: () => manager.get("owned-fixture"),
  };
}

test("a private tmux reap trigger recovers the real exit code after a lost child signal", async (t) => {
  const { manager, native, stopped, reapRequests, read } = await fixture(t);
  await read();
  assert.deepEqual(reapRequests, []);
  native.pane_dead = "1";
  native.afterReap = () => {
    native.pane_dead_status = "7";
  };
  const exited = await read();
  assert.equal(exited.status, "stopped");
  assert.equal(exited.exitCode, 7);
  assert.equal((await manager.metadata("owned-fixture")).exitCode, 7);
  assert.deepEqual(stopped, ["owned-fixture"]);
  assert.deepEqual(reapRequests, [["run-shell", "-t", "=tuiui-owned-fixture:0.0", ":"]]);
  await read();
  assert.equal(reapRequests.length, 1);
});

test("a closed pane stays pending until tmux reports its nonzero exit status", async (t) => {
  const { manager, native, stopped, read } = await fixture(t);
  assert.equal((await read()).status, "running");
  native.pane_dead = "1";
  for (let sample = 0; sample < 2; sample++) {
    const pending = await read();
    assert.equal(pending.status, "running");
    assert.equal(pending.exitCode, undefined);
  }
  assert.deepEqual(stopped, []);
  assert.equal((await manager.metadata("owned-fixture")).exitCode, undefined);
  native.pane_dead_status = "7";
  const exited = await read();
  assert.equal(exited.status, "stopped");
  assert.equal(exited.exitCode, 7);
  assert.equal((await manager.metadata("owned-fixture")).exitCode, 7);
  await read();
  assert.deepEqual(stopped, ["owned-fixture"]);
});

test("a reported zero exit status is successful rather than pending", async (t) => {
  const { native, stopped, read } = await fixture(t);
  Object.assign(native, { pane_dead: "1", pane_dead_status: "0" });
  const exited = await read();
  assert.equal(exited.status, "stopped");
  assert.equal(exited.exitCode, 0);
  assert.deepEqual(stopped, ["owned-fixture"]);
});

test("signal termination is stopped without inventing a successful exit code", async (t) => {
  const { native, stopped, read } = await fixture(t);
  Object.assign(native, { pane_dead: "1", pane_dead_signal: "TERM" });
  const exited = await read();
  assert.equal(exited.status, "stopped");
  assert.equal(exited.exitCode, undefined);
  assert.deepEqual(stopped, ["owned-fixture"]);
});

test("a missing pane preserves a previously reported exit status", async (t) => {
  const { native, read } = await fixture(t, { status: "stopped", exitCode: 7 });
  native.missing = true;
  const missing = await read();
  assert.equal(missing.status, "stopped");
  assert.equal(missing.exitCode, 7);
});
