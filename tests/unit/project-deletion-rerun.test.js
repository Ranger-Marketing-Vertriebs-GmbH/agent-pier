import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deletionScope } from "../../server/application/project-deletion-scope.js";
import {
  annotateFolders,
  listedDeletions,
} from "../../server/application/project-folder-annotations.js";
import { owner, quietLog, setup } from "../helpers/project-deletion.js";

const report = { unsavedGitWork: false, endedSessionIds: [], endedProcesses: [] };

// The record start() writes, built by hand from the scope.
async function mark(f, extra = {}) {
  const scope = await deletionScope(f.services, f.app);
  return f.memory.deletions.mark(scope.path, {
    ...scope,
    folderMissing: scope.folderState === "missing",
    nested: [],
    report,
    ...extra,
  });
}

async function startAll(f) {
  const checked = await f.deletion.preflight(f.app);
  await f.deletion.start(
    { path: f.app, token: checked.token, name: checked.name },
    owner,
  );
  await f.deletion.settled(f.app);
}

test("a folder the deletion removed is never deleted again, even with its inode", async (t) => {
  quietLog(t);
  let left = ["memory"];
  const f = await setup(t, { dataLeft: () => left });
  await startAll(f);
  const failed = f.memory.deletions.get(f.app);
  assert.equal(failed.error, "PROJECT_DATA_LEFT");
  assert.equal(failed.body.folderRemoved, true);
  assert.equal(fs.existsSync(f.app), false);

  // The owner clones again at the same path; the new folder got the old inode.
  fs.mkdirSync(f.app);
  fs.writeFileSync(path.join(f.app, "new-clone.txt"), "keep me");
  const now = fs.lstatSync(f.app, { bigint: true });
  f.memory.deletions.update(f.app, {
    ...failed.body,
    dev: String(now.dev),
    ino: String(now.ino),
    birth: now.birthtimeNs > 0n ? String(now.birthtimeNs) : "",
  });
  left = [];
  await f.deletion.retry(f.app, owner);
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app).error, "PROJECT_FOLDER_REAPPEARED");
  assert.equal(fs.readFileSync(path.join(f.app, "new-clone.txt"), "utf8"), "keep me");
  // A start-up resume after a crash right after rm does not delete it either.
  f.memory.deletions.again(f.app);
  await f.deletion.resume();
  await f.deletion.settled(f.app);
  assert.equal(fs.existsSync(path.join(f.app, "new-clone.txt")), true);
});

test("a folder gone before its removal is recorded as removed", async (t) => {
  const f = await setup(t);
  await mark(f);
  fs.rmSync(f.app, { recursive: true });
  await f.deletion.resume();
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app), null);
  assert.equal(f.audits.length, 1);
});

test("a folder with the recorded inode but another creation time is kept", async (t) => {
  quietLog(t);
  const f = await setup(t);
  const { birthtimeNs } = fs.lstatSync(f.app, { bigint: true });
  if (!(birthtimeNs > 0n)) return t.skip("no creation time on this file system");
  const scope = await deletionScope(f.services, f.app);
  assert.equal(scope.birth, String(birthtimeNs));
  await mark(f, { birth: String(birthtimeNs + 1n) });
  await f.deletion.resume();
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app).error, "PROJECT_FOLDER_CHANGED");
  assert.equal(fs.existsSync(path.join(f.app, "src", "index.js")), true);
});

test("a deletion waiting for the agents blocks no folder and is not listed", async (t) => {
  const f = await setup(t);
  const parent = path.dirname(f.app);
  // An earlier deletion of the folder around it finished except the agents' grants.
  f.memory.deletions.mark(parent, { projectIds: ["old-parent"], sessionIds: [] });
  f.memory.deletions.fail(parent, "PROJECT_AGENTS_OFF");
  // And one at this very path, of a project registered there before.
  f.memory.deletions.mark(f.app, {
    projectIds: ["old"],
    sessionIds: ["old-session"],
    dataRemoved: true,
  });
  f.memory.deletions.fail(f.app, "PROJECT_AGENTS_OFF");
  assert.deepEqual(listedDeletions(f.memory), []);
  const [row] = await annotateFolders(f.memory, [{ cwd: f.app }], (row) => row.cwd);
  assert.equal(row.deletion, null);

  await startAll(f);
  assert.equal(fs.existsSync(f.app), false);
  assert.equal(f.memory.deletions.get(f.app), null);
  // The new deletion took over the waiting one's ids and revoked them as well.
  assert.ok(f.calls.includes("revoke:old"));
  assert.equal(f.memory.deletions.get(parent).error, "PROJECT_AGENTS_OFF");
});

test("an aborted start writes back the record it replaced", async (t) => {
  const f = await setup(t);
  f.memory.deletions.mark(f.app, { projectIds: ["old"], sessionIds: [] });
  f.memory.deletions.fail(f.app, "PROJECT_AGENTS_OFF");
  const before = f.memory.deletions.get(f.app);
  const checked = await f.deletion.preflight(f.app);
  f.services.assistantWorkflows.revokeProject = () => {
    throw Object.assign(new Error("busy"), { status: 503 });
  };
  await assert.rejects(
    f.deletion.start({ path: f.app, token: checked.token, name: checked.name }, owner),
    { code: "PROJECT_DELETE_ABORTED" },
  );
  assert.deepEqual(f.memory.deletions.get(f.app), before);
  assert.equal(fs.existsSync(f.app), true);
});

test("of a folder and one inside it started at once, only one deletes", async (t) => {
  const f = await setup(t);
  const inner = path.join(f.app, "src");
  await f.memory.register(inner);
  const [outerCheck, innerCheck] = await Promise.all([
    f.deletion.preflight(f.app),
    f.deletion.preflight(inner),
  ]);
  const results = await Promise.allSettled([
    f.deletion.start(
      { path: f.app, token: outerCheck.token, name: outerCheck.name },
      owner,
    ),
    f.deletion.start(
      { path: inner, token: innerCheck.token, name: innerCheck.name },
      owner,
    ),
  ]);
  const started = results.filter((result) => result.status === "fulfilled");
  assert.equal(started.length, 1);
  const [refused] = results.filter((result) => result.status === "rejected");
  assert.equal(refused.reason.code, "PROJECT_DELETING");
  assert.equal(refused.reason.grantsRevoked, undefined);
  await f.deletion.settled(f.app);
  await f.deletion.settled(inner);
  assert.deepEqual(f.memory.deletions.list(), []);
});
