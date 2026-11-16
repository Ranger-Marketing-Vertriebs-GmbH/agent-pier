import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeletionGuard } from "../../server/features/projects/deletion-guard.js";

const records = (entries) => ({
  list: () =>
    entries.map(([folder, projectIds = []]) => ({ path: folder, body: { projectIds } })),
});

function folders(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-guard-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  fs.mkdirSync(path.join(app, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "app-two"));
  return { root, app };
}

test("covers a folder and everything below it, only while recorded", (t) => {
  const { root, app } = folders(t);
  let current = records([[app, ["p1"]]]);
  const guard = new DeletionGuard(() => current);
  assert.equal(guard.covers(app), true);
  assert.equal(guard.covers(path.join(app, "src")), true);
  assert.equal(guard.covers(path.join(app, "missing", "deep")), true);
  assert.equal(guard.covers(path.join(root, "app-two")), false);
  assert.equal(guard.covers(root), false);
  assert.equal(guard.covers(""), false);
  assert.equal(guard.coversProject("p1"), true);
  assert.equal(guard.coversProject("p2"), false);
  current = records([]);
  assert.equal(guard.covers(app), false);
  assert.equal(guard.coversProject("p1"), false);
  current = null;
  assert.equal(guard.covers(app), false);
});

test("covers a session cwd given through a link", (t) => {
  const { root, app } = folders(t);
  const link = path.join(root, "link");
  fs.symlinkSync(app, link);
  const guard = new DeletionGuard(() => records([[app]]));
  assert.equal(guard.covers(link), true);
  assert.equal(guard.covers(path.join(link, "src")), true);
  assert.equal(guard.covers(path.join(link, "src") + path.sep), true);
});

test("refuse throws PROJECT_DELETING with 409", (t) => {
  const { app } = folders(t);
  const guard = new DeletionGuard(() => records([[app, ["p1"]]]));
  for (const call of [() => guard.refuse(app), () => guard.refuseProject("p1")])
    assert.throws(call, (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "PROJECT_DELETING");
      assert.equal(error.message, "Dieses Projekt wird gerade gelöscht.");
      return true;
    });
  assert.doesNotThrow(() => guard.refuse(path.join(app, "..")));
  assert.doesNotThrow(() => guard.refuseProject("p2"));
});

test("a failed deletion still refuses new work in its folder", (t) => {
  const { app } = folders(t);
  const guard = new DeletionGuard(() => ({
    list: () => [
      { path: app, state: "failed", error: "EACCES", body: { projectIds: ["p1"] } },
    ],
  }));
  assert.throws(() => guard.refuse(path.join(app, "src")), { code: "PROJECT_DELETING" });
  assert.throws(() => guard.refuseProject("p1"), { code: "PROJECT_DELETING" });
});
