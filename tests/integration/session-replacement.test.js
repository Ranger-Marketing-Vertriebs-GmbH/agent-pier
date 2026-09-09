import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "../../server/features/sessions/session-manager.js";

test("replacement preserves identity and scoped metadata without normal stop cleanup", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "ap-replacement-"));
  let stopped = 0;
  const manager = new SessionManager({
    dataDir,
    onStopped: () => {
      stopped++;
    },
  });
  t.after(async () => {
    await manager.close();
    await manager.tmux(["kill-server"]).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
    await rm(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  const launch = { command: "/bin/sh", args: ["-c", "sleep 120"], env: {} };
  const session = await manager.create({
    id: "reload-test",
    name: "Work",
    tool: "codex",
    accountId: "test-account",
    cwd: dataDir,
    attachments: { directory: dataDir },
    nativeModelId: "chosen-model",
    ...launch,
  });
  await manager.updateReload(session.id, {
    state: "reloading",
    nativeId: "exact-native",
  });
  const result = await manager.replace(session.id, async () => ({
    ...launch,
    sshTools: { enabled: true, generation: "new" },
  }));
  assert.equal(result.id, session.id);
  assert.equal(result.createdAt, session.createdAt);
  assert.deepEqual(result.attachments, session.attachments);
  assert.equal(result.nativeModelId, "chosen-model");
  assert.equal(result.restartGeneration, 1);
  assert.equal(result.sshTools.generation, "new");
  assert.equal(stopped, 0);
  await assert.rejects(manager.input(session.id, "must-not-replay", true), /reloading/);
  await assert.rejects(
    manager.control(session.id, () => assert.fail("No model input")),
    /reloading/,
  );
  const terminal = await manager.attach(session.id);
  await assert.rejects(terminal.write("must-not-replay"), /reloading/);
  terminal.dispose();
  await assert.rejects(
    manager.replace(session.id, async () => {
      throw Error("prepare failed");
    }),
  );
  assert.equal((await manager.get(session.id)).status, "stopped");
  assert.equal(stopped, 0);
  const recovered = new SessionManager({
    dataDir,
    onStopped: () => {
      stopped++;
    },
  });
  await recovered.get(session.id);
  assert.equal(stopped, 0);
  await recovered.close();
  await manager.stop(session.id);
  assert.equal(stopped, 1);
});
