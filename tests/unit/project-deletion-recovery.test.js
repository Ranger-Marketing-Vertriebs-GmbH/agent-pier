import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { deletionScope } from "../../server/application/project-deletion-scope.js";
import { deletionKey } from "../../server/application/project-deletion.js";
import { owner, quietLog, setup } from "../helpers/project-deletion.js";

const user = { role: "user", userId: "u1" };

// The record start() writes, built by hand from the scope.
async function mark(f, extra = {}) {
  const scope = await deletionScope(f.services, f.app);
  return f.memory.deletions.mark(scope.path, {
    name: scope.name,
    folderMissing: scope.folderState === "missing",
    dev: scope.dev,
    ino: scope.ino,
    projectIds: scope.projectIds,
    repositoryIds: scope.repositoryIds,
    busIds: scope.busIds,
    sessionIds: scope.sessionIds,
    runIds: scope.runIds,
    rebuildIds: scope.rebuildIds,
    nested: [],
    report: { unsavedGitWork: false, endedSessionIds: [], endedProcesses: [] },
    ...extra,
  });
}

const using = { pid: 4242, name: "vite", uid: process.getuid?.() ?? 0, uses: "cwd" };

test("retry rescans the folder and keeps it while a process uses it", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores file modes");
  quietLog(t);
  const processes = [];
  const f = await setup(t, { processes });
  const locked = path.join(f.app, "locked");
  fs.mkdirSync(path.join(locked, "inner"), { recursive: true });
  fs.writeFileSync(path.join(locked, "inner", "file"), "x");
  fs.chmodSync(locked, 0o500);
  t.after(() => fs.existsSync(locked) && fs.chmodSync(locked, 0o700));
  const report = await f.deletion.preflight(f.app);
  await f.deletion.start({ path: f.app, token: report.token, name: report.name }, owner);
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app).error, "EACCES");
  fs.chmodSync(locked, 0o700);
  processes.push(using);
  await assert.rejects(f.deletion.retry(f.app, owner), {
    status: 409,
    code: "PROJECT_DELETE_BLOCKED",
    grantsRevoked: true,
  });
  assert.equal(f.memory.deletions.get(f.app).state, "failed");
  assert.equal(f.memory.deletions.get(f.app).error, "PROJECT_DELETE_BLOCKED");
  assert.equal(fs.existsSync(path.join(locked, "inner", "file")), true);
  assert.equal(f.memory.hasProject(f.id), true);
});

test("resume fails a deletion whose folder a process uses or a scan misses", async (t) => {
  for (const scan of ["process", "timeout"]) {
    const f = await setup(t);
    f.deletion.probes.scan = async () =>
      scan === "process"
        ? { status: "ok", processes: [using] }
        : { status: "timeout", processes: [] };
    await mark(f);
    await f.deletion.resume();
    await f.deletion.settled(f.app);
    assert.equal(f.memory.deletions.get(f.app).error, "PROJECT_DELETE_BLOCKED");
    assert.equal(fs.existsSync(f.app), true);
  }
});

test("start-up resume returns before the deletion ran", async (t) => {
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const f = await setup(t, { beforeData: () => gate });
  await mark(f);
  await f.deletion.resume();
  assert.equal(f.memory.deletions.get(f.app).state, "deleting");
  open();
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app), null);
  assert.equal(fs.existsSync(f.app), false);
  assert.equal(f.audits.length, 1);
});

test("a missing folder that reappears before its removal is kept", async (t) => {
  quietLog(t);
  const f = await setup(t);
  fs.renameSync(f.app, `${f.app}-away`);
  await mark(f);
  fs.renameSync(`${f.app}-away`, f.app);
  await f.deletion.resume();
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app).error, "PROJECT_FOLDER_REAPPEARED");
  assert.equal(fs.existsSync(path.join(f.app, "src", "index.js")), true);
  assert.equal(f.memory.hasProject(f.id), true);
  // A new check and start delete it as a present folder.
  const report = await f.deletion.preflight(f.app);
  await f.deletion.start({ path: f.app, token: report.token, name: report.name }, owner);
  await f.deletion.settled(f.app);
  assert.equal(fs.existsSync(f.app), false);
  assert.equal(f.memory.deletions.get(f.app), null);
});

test("only another folder identity is a changed folder; stat errors keep their code", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores file modes");
  quietLog(t);
  const f = await setup(t);
  await mark(f, { ino: "1" });
  await f.deletion.resume();
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app).error, "PROJECT_FOLDER_CHANGED");
  assert.equal(fs.existsSync(f.app), true);

  const g = await setup(t);
  await mark(g);
  const parent = path.dirname(g.app);
  fs.chmodSync(parent, 0o600);
  t.after(() => fs.existsSync(parent) && fs.chmodSync(parent, 0o700));
  await g.deletion.resume();
  await g.deletion.settled(g.app);
  fs.chmodSync(parent, 0o700);
  assert.equal(g.memory.deletions.get(g.app).error, "EACCES");
  assert.equal(fs.existsSync(g.app), true);
});

test("paths through a linked parent meet one deletion", async (t) => {
  const f = await setup(t);
  const alias = path.join(f.root, "alias");
  fs.symlinkSync(path.dirname(f.app), alias);
  const through = path.join(alias, "app");
  assert.equal(deletionKey(`${through}/`), f.app);
  const report = await f.deletion.preflight(through);
  assert.equal(report.refused, null);
  assert.equal(report.path, f.app);
  await f.deletion.start(
    { path: through, token: report.token, name: report.name },
    owner,
  );
  await f.deletion.settled(through);
  assert.equal(fs.existsSync(f.app), false);
  assert.equal(f.memory.deletions.get(f.app), null);
  // A link as the folder itself is not followed: it is refused.
  fs.mkdirSync(f.app);
  await f.memory.register(f.app);
  const link = path.join(f.root, "work", "link");
  fs.symlinkSync(f.app, link);
  assert.equal(deletionKey(link), link);
});

test("agents starting during a deletion leave it to its own job", async (t) => {
  const f = await setup(t);
  const report = await f.deletion.preflight(f.app);
  const revoke = f.services.assistantWorkflows.revokeProject;
  f.services.assistantWorkflows.revokeProject = (id) => {
    revoke(id);
    void f.deletion.resume(); // as on the agents' "started" event
  };
  await f.deletion.start({ path: f.app, token: report.token, name: report.name }, user);
  await f.deletion.settled(f.app);
  assert.equal(f.audits.length, 1);
  // The job of the start ran it, as the user who started it.
  assert.equal(f.audits[0].actorUserId, "u1");
});

test("a failed session stop is not recorded as ended", async (t) => {
  quietLog(t);
  const found = [
    {
      pid: 7,
      startTime: "t7",
      name: "claude",
      owner: "self",
      known: { kind: "session", sessionId: "pane" },
      endable: true,
      protected: false,
    },
  ];
  const f = await setup(t, { processes: found });
  f.session("pane", { cwd: path.join(f.root, "elsewhere") });
  f.services.sessions.stop = async () => {
    throw Object.assign(new Error("tmux"), { code: "TMUX_FAILED" });
  };
  const report = await f.deletion.preflight(f.app);
  await f.deletion.endBlockers(
    { path: f.app, token: report.token, processes: [{ pid: 7, startTime: "t7" }] },
    owner,
  );
  found.length = 0;
  const after = await f.deletion.preflight(f.app);
  await f.deletion.start({ path: f.app, token: after.token, name: after.name }, owner);
  await f.deletion.settled(f.app);
  assert.deepEqual(f.audits[0].details.endedSessionIds, []);
});
