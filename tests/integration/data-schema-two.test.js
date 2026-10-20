import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { NotificationService } from "../../server/features/notifications/notification-service.js";
import {
  dataSchemaVersion,
  requireDataCompatibility,
} from "../../server/features/operations/release-schema.js";
import { releaseManifest } from "../../server/features/operations/release-archive.js";

async function dataDir(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-schema-two-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const send = async () => ({ statusCode: 201 });
const file = (dir) => path.join(dir, "notifications/notifications.sqlite");
function inspect(dir) {
  const db = new DatabaseSync(file(dir), { readOnly: true });
  try {
    return {
      version: db.prepare("PRAGMA user_version").get().user_version,
      columns: db
        .prepare("PRAGMA table_info(subscriptions)")
        .all()
        .map((column) => column.name),
    };
  } finally {
    db.close();
  }
}

test("starting migrates notifications to schema 2 once", async (t) => {
  const dir = await dataDir(t);
  // A schema 1 database as older releases wrote it.
  await fs.mkdir(path.dirname(file(dir)), { recursive: true });
  const old = new DatabaseSync(file(dir));
  old.exec(
    "CREATE TABLE subscriptions (id TEXT PRIMARY KEY,device_id TEXT NOT NULL UNIQUE,public TEXT NOT NULL,secret TEXT NOT NULL); INSERT INTO subscriptions VALUES('s1','d1','{}','{}'); PRAGMA user_version=1;",
  );
  old.close();
  for (let start = 0; start < 2; start++) {
    await new NotificationService({ dataDir: dir, send }).close();
  }
  const state = inspect(dir);
  assert.equal(state.version, 2);
  assert.equal(state.columns.filter((name) => name === "user_id").length, 1);
  assert.equal(dataSchemaVersion(dir), 2);
});

test("a newer schema is never lowered on start", async (t) => {
  const dir = await dataDir(t);
  await new NotificationService({ dataDir: dir, send }).close();
  const db = new DatabaseSync(file(dir));
  db.exec("PRAGMA user_version=3");
  db.close();
  await new NotificationService({ dataDir: dir, send }).close();
  assert.equal(inspect(dir).version, 3);
});

test("a release that opens only schema 1 is refused on schema 2 data", async (t) => {
  const dir = await dataDir(t);
  await new NotificationService({ dataDir: dir, send }).close();
  assert.throws(() => requireDataCompatibility({ schemaMin: 1, schemaMax: 1 }, dir), {
    status: 409,
  });
  requireDataCompatibility({ schemaMin: 1, schemaMax: 2 }, dir);
  const platform = "linux-x64";
  const manifest = { version: "2.5.0", platform, schemaVersion: 1, schemaMin: 1 };
  // The manifest check stays structural: a schema 1 release is valid, only not here.
  assert.equal(releaseManifest({ ...manifest, schemaMax: 1 }, platform).schemaMax, 1);
  assert.equal(releaseManifest({ ...manifest, schemaMax: 2 }, platform).schemaMax, 2);
  for (const range of [
    { schemaMin: 0, schemaMax: 1 },
    { schemaMin: 2, schemaMax: 1 },
  ])
    assert.throws(() => releaseManifest({ ...manifest, ...range }, platform), {
      status: 409,
    });
});
