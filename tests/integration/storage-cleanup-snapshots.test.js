import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { writePrivate } from "../../server/lib/storage.js";
import {
  deleteSnapshot,
  listSnapshots,
} from "../../server/features/system-status/cleanup-snapshots.js";

function fixture(t, journal = { phase: "complete" }) {
  const dataDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-snap-")),
  );
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, "assistants");
  fs.mkdirSync(path.join(root, "backup-keys"), { recursive: true, mode: 0o700 });
  const backup = (
    createdAt,
    { committed = true, from = "2026.10.3", to = "2026.10.7" } = {},
  ) => {
    const id = randomUUID();
    const folder = path.join(root, "backups", id);
    fs.mkdirSync(path.join(folder, "payload"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, "payload", "state.bin"),
      Buffer.alloc(32 * 1024, 1),
    );
    writePrivate(path.join(folder, "snapshot.json"), {
      format: 2,
      previous: { version: from },
      candidate: { version: to },
      createdAt,
    });
    if (committed) fs.writeFileSync(path.join(folder, "committed"), "now");
    fs.writeFileSync(path.join(root, "backup-keys", `${id}.key`), Buffer.alloc(32, 7));
    return id;
  };
  const ids = {
    older: backup(Date.parse("2026-09-01T10:00:00Z"), {
      from: "2026.9.8",
      to: "2026.10.3",
    }),
    newer: backup(Date.parse("2026-10-20T10:00:00Z")),
  };
  writePrivate(path.join(root, "update.json"), { ...journal, backup: journal.backup });
  const updates = () =>
    new RuntimeUpdates({
      dataDir,
      runtime: { status: () => ({ availability: "disabled" }) },
      maintenance: {},
    });
  return { dataDir, root, ids, updates, backup };
}
const exists = (root, id) => ({
  folder: fs.existsSync(path.join(root, "backups", id)),
  key: fs.existsSync(path.join(root, "backup-keys", `${id}.key`)),
});

test("update backups are listed newest first with versions and size", async (t) => {
  const { dataDir, ids, updates } = fixture(t);
  const { blocked, snapshots } = await listSnapshots({ dataDir, updates: updates() });
  assert.equal(blocked, false);
  assert.deepEqual(
    snapshots.map((s) => [s.id, s.previousVersion, s.targetVersion, s.reason]),
    [
      [ids.newer, "2026.10.3", "2026.10.7", null],
      [ids.older, "2026.9.8", "2026.10.3", null],
    ],
  );
  assert.ok(snapshots[0].bytes >= 32 * 1024);
  assert.equal(snapshots[0].createdAt, "2026-10-20T10:00:00.000Z");
  assert.ok(snapshots[0].committedAt);
  assert.ok(!JSON.stringify(snapshots).includes(dataDir), "no path in the list");
});

for (const withService of [true, false])
  test(`deleting a backup removes it and its key (${withService ? "agents on" : "agents off"})`, async (t) => {
    const { dataDir, root, ids, updates } = fixture(t);
    const context = { dataDir, updates: withService ? updates() : null };
    const removed = await deleteSnapshot(context, ids.older);
    assert.ok(removed.bytes >= 32 * 1024);
    assert.deepEqual(exists(root, ids.older), { folder: false, key: false });
    assert.deepEqual(exists(root, ids.newer), { folder: true, key: true });
    await assert.rejects(deleteSnapshot(context, ids.older), { status: 404 });
    await assert.rejects(deleteSnapshot(context, "../../x"), { status: 404 });
  });

for (const phase of [
  "snapshotting",
  "activating",
  "validating",
  "rolling_back",
  "staging",
])
  test(`no backup is deleted while an update is ${phase}`, async (t) => {
    const { dataDir, root, ids, updates } = fixture(t, { phase });
    for (const service of [updates(), null]) {
      const { blocked } = await listSnapshots({ dataDir, updates: service });
      assert.equal(blocked, true);
      await assert.rejects(deleteSnapshot({ dataDir, updates: service }, ids.older), {
        status: 409,
      });
    }
    assert.deepEqual(exists(root, ids.older), { folder: true, key: true });
  });

test("the backup of an unresolved recovery is marked and kept", async (t) => {
  const base = fixture(t);
  const id = base.backup(Date.now(), { committed: false });
  writePrivate(path.join(base.root, "update.json"), {
    phase: "recovery_required",
    backup: id,
  });
  const updates = base.updates();
  const { snapshots } = await listSnapshots({ dataDir: base.dataDir, updates });
  assert.equal(snapshots.find((s) => s.id === id).reason, "recovery");
  await assert.rejects(deleteSnapshot({ dataDir: base.dataDir, updates }, id), {
    status: 409,
  });
  assert.equal(exists(base.root, id).folder, true);
});

test("a running update or agent maintenance refuses the deletion", async (t) => {
  const { dataDir, root, ids, updates } = fixture(t);
  const service = updates();
  service.busy = true;
  await assert.rejects(deleteSnapshot({ dataDir, updates: service }, ids.older), {
    status: 409,
  });
  await assert.rejects(
    deleteSnapshot({ dataDir, updates: updates(), maintenance: true }, ids.older),
    { status: 409 },
  );
  // Without the agent services, an interrupted maintenance on disk refuses too.
  fs.writeFileSync(path.join(root, "runtime-maintenance.json"), "{}");
  await assert.rejects(deleteSnapshot({ dataDir, updates: null }, ids.older), {
    status: 409,
  });
  assert.equal(exists(root, ids.older).folder, true);
});
