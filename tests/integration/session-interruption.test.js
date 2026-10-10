import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

const launch = { command: "/bin/sh", args: ["-c", "sleep 120"], env: {} };
async function fixture(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ap-interruption-"));
  const manager = new SessionManager({ dataDir });
  const interrupted = [];
  manager.onInterrupted = (session) => interrupted.push(session.id);
  t.after(async () => {
    await manager.close();
    await manager.tmux(["kill-server"]).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  const create = (id) =>
    manager.create({
      id,
      name: id,
      tool: "codex",
      accountId: "a",
      cwd: dataDir,
      ...launch,
    });
  return { manager, interrupted, create };
}

test("a killed tmux server marks every running session as interrupted", async (t) => {
  const { manager, interrupted, create } = await fixture(t);
  const one = await create("lost-one");
  await create("lost-two");
  assert.equal(typeof one.tmuxServer.pid, "number");
  assert.equal(typeof one.tmuxServer.startTime, "number");
  await manager.tmux(["kill-server"]);
  for (const id of ["lost-one", "lost-two"]) {
    const session = await manager.get(id);
    assert.equal(session.status, "stopped");
    assert.equal(session.interruption.resume, "pending");
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(interrupted.sort(), ["lost-one", "lost-two"]);
});

test("a stopped session is not marked when the server dies later", async (t) => {
  const { manager, create } = await fixture(t);
  await create("kept-stopped");
  await create("still-running");
  await manager.stop("kept-stopped");
  await manager.tmux(["kill-server"]);
  assert.equal((await manager.get("kept-stopped")).interruption, undefined);
  assert.equal((await manager.get("still-running")).interruption.resume, "pending");
});

test("a replacement after an interruption records the new server and clears the marker", async (t) => {
  const { manager, create } = await fixture(t);
  const before = await create("replaced");
  await manager.tmux(["kill-server"]);
  assert.equal((await manager.get("replaced")).interruption.resume, "pending");
  await manager.updateReload("replaced", { state: "reloading", nativeId: "native" });
  const after = await manager.replace("replaced", async () => launch);
  assert.equal(after.status, "running");
  assert.equal(after.interruption, undefined);
  assert.notDeepEqual(after.tmuxServer, before.tmuxServer);
  assert.equal((await manager.metadata("replaced")).interruption, undefined);
});

test("a replacement whose server probe answers empty drops the stale identity", async (t) => {
  const { manager, create } = await fixture(t);
  assert.equal(typeof (await create("unprobed")).tmuxServer.pid, "number");
  await manager.tmux(["kill-server"]);
  assert.equal((await manager.get("unprobed")).interruption.resume, "pending");
  await manager.updateReload("unprobed", { state: "reloading", nativeId: "native" });
  const tmux = manager.tmux.bind(manager);
  let launched = false;
  t.mock.method(manager, "tmux", async (args) => {
    if (args[0] === "new-session") launched = true;
    if (launched && args[0] === "list-sessions") return "";
    return tmux(args);
  });
  const after = await manager.replace("unprobed", async () => launch);
  assert.equal(after.status, "running");
  assert.equal(after.tmuxServer, undefined);
  assert.equal((await manager.metadata("unprobed")).tmuxServer, undefined);
});
