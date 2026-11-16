import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { AGENTS_OFF } from "../../server/application/project-deletion.js";
import { owner, quietLog, setup } from "../helpers/project-deletion.js";

test("start refuses a stale token, a wrong name and a dangerous path", async (t) => {
  const f = await setup(t);
  const report = await f.deletion.preflight(f.app);
  assert.equal(report.ready, true);
  await assert.rejects(
    f.deletion.start({ path: f.app, token: "0".repeat(64), name: report.name }, owner),
    { status: 409, code: "PROJECT_DELETE_STALE" },
  );
  await assert.rejects(
    f.deletion.start({ path: f.app, token: report.token, name: "other" }, owner),
    { status: 400, code: "PROJECT_DELETE_NAME" },
  );
  // The home folder of the configuration is never deleted.
  f.services.config.home = f.app;
  const home = await f.deletion.preflight(f.app);
  assert.equal(home.refused, "home");
  await assert.rejects(
    f.deletion.start({ path: f.app, token: home.token, name: home.name }, owner),
    { status: 409, code: "PROJECT_DELETE_REFUSED", reason: "home" },
  );
  assert.deepEqual(f.memory.deletions.list(), []);
  assert.equal(fs.existsSync(f.app), true);
  assert.equal(f.memory.hasProject(f.id), true);
});

test("a replaced folder makes the token stale", async (t) => {
  const f = await setup(t);
  const report = await f.deletion.preflight(f.app);
  fs.renameSync(f.app, `${f.app}-moved`);
  fs.mkdirSync(f.app);
  fs.writeFileSync(path.join(f.app, "keep.txt"), "new");
  await assert.rejects(
    f.deletion.start({ path: f.app, token: report.token, name: report.name }, owner),
    { status: 409, code: "PROJECT_DELETE_STALE" },
  );
  await f.deletion.settled(f.app);
  assert.equal(fs.readFileSync(path.join(f.app, "keep.txt"), "utf8"), "new");
  assert.equal(fs.existsSync(`${f.app}-moved`), true);
  assert.equal(f.memory.deletions.get(f.app), null);
});

test("start re-checks blockers after marking and clears the mark when one appears", async (t) => {
  const f = await setup(t);
  const report = await f.deletion.preflight(f.app);
  // A run starts between the preflight and the re-check after the mark.
  const revoke = f.services.assistantWorkflows.revokeProject;
  f.services.assistantWorkflows.revokeProject = (id) => {
    revoke(id);
    assert.equal(f.memory.deletions.get(f.app).state, "deleting");
    f.runs.set("late", { id: "late", projectId: f.id, cwd: f.app, status: "running" });
  };
  await assert.rejects(
    f.deletion.start({ path: f.app, token: report.token, name: report.name }, owner),
    { status: 409, code: "PROJECT_DELETE_BLOCKED" },
  );
  assert.equal(f.memory.deletions.get(f.app), null);
  assert.equal(fs.existsSync(f.app), true);
  assert.equal(f.memory.hasProject(f.id), true);
  assert.equal(f.calls.at(-1), "signal:projects.changed");
});

test("order: mark, revoke grants, delete folder, remove data, drop record", async (t) => {
  const f = await setup(t);
  const report = await f.deletion.preflight(f.app);
  const events = [];
  const deletions = f.memory.deletions;
  for (const method of ["mark", "drop", "fail"]) {
    const original = deletions[method].bind(deletions);
    deletions[method] = (...args) => {
      events.push(`${method}:${fs.existsSync(f.app) ? "folder" : "gone"}`);
      return original(...args);
    };
  }
  f.calls.length = 0;
  const started = await f.deletion.start(
    { path: `${f.app}/`, token: report.token, name: report.name },
    owner,
  );
  assert.deepEqual(started, { state: "deleting" });
  await f.deletion.settled(f.app);
  const order = f.calls.filter((call) => !call.startsWith("signal:"));
  assert.deepEqual(order, [`revoke:${f.id}`, `data:${f.app}`]);
  // Marked (and re-marked with the fresh ids) while the folder exists, dropped after.
  assert.deepEqual(events, ["mark:folder", "mark:folder", "drop:gone"]);
  assert.equal(fs.existsSync(f.app), false);
  assert.equal(f.memory.hasProject(f.id), false);
  assert.equal(f.memory.deletions.get(f.app), null);
  assert.ok(f.calls.includes("signal:projects.changed"));
});

test("a partial rm leaves a failed record that retry finishes", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root ignores file modes");
  quietLog(t);
  const f = await setup(t);
  const locked = path.join(f.app, "locked");
  fs.mkdirSync(path.join(locked, "inner"), { recursive: true });
  fs.writeFileSync(path.join(locked, "inner", "file"), "x");
  fs.chmodSync(locked, 0o500);
  t.after(() => fs.existsSync(locked) && fs.chmodSync(locked, 0o700));
  const report = await f.deletion.preflight(f.app);
  await f.deletion.start({ path: f.app, token: report.token, name: report.name }, owner);
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app).state, "failed");
  assert.equal(f.memory.deletions.get(f.app).error, "EACCES");
  assert.equal(f.memory.hasProject(f.id), true); // data kept while the folder is not gone
  assert.equal(f.audits.length, 0);
  fs.chmodSync(locked, 0o700);
  assert.deepEqual(await f.deletion.retry(f.app, owner), { state: "deleting" });
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app), null);
  assert.equal(fs.existsSync(f.app), false);
  assert.equal(f.memory.hasProject(f.id), false);
  assert.equal(f.audits.length, 1);
  await assert.rejects(f.deletion.retry(f.app, owner), {
    status: 409,
    code: "PROJECT_DELETE_NOT_FAILED",
  });
});

test("a missing folder needs no name and skips the folder step", async (t) => {
  const f = await setup(t);
  fs.rmSync(f.app, { recursive: true });
  const report = await f.deletion.preflight(f.app);
  assert.equal(report.folderState, "missing");
  await f.deletion.start({ path: f.app, token: report.token }, owner);
  await f.deletion.settled(f.app);
  assert.equal(f.memory.hasProject(f.id), false);
  assert.equal(f.memory.deletions.get(f.app), null);
  assert.equal(f.audits[0].details.folderMissing, true);
});

test("a folder that reappeared refuses the missing-folder removal", async (t) => {
  const f = await setup(t);
  fs.renameSync(f.app, `${f.app}-away`);
  const report = await f.deletion.preflight(f.app);
  fs.renameSync(`${f.app}-away`, f.app);
  await assert.rejects(f.deletion.start({ path: f.app, token: report.token }, owner), {
    status: 409,
    code: "PROJECT_FOLDER_REAPPEARED",
  });
  assert.equal(fs.existsSync(path.join(f.app, "src", "index.js")), true);
  assert.equal(f.memory.hasProject(f.id), true);
  assert.equal(f.memory.deletions.get(f.app), null);
});

test("endBlockers stops sessions and ends only ticked, endable processes", async (t) => {
  const proc = (pid, extra = {}) => ({
    pid,
    startTime: `t${pid}`,
    name: `proc${pid}`,
    owner: "self",
    known: null,
    endable: true,
    protected: false,
    ...extra,
  });
  const found = [
    proc(101),
    proc(102),
    proc(103, { endable: false, owner: "other" }),
    proc(104, { known: { kind: "session", sessionId: "pane" } }),
  ];
  const f = await setup(t, { processes: found });
  f.session("s1");
  f.session("pane", { cwd: path.join(f.root, "elsewhere") }, "running");
  f.runs.set("r1", { id: "r1", projectId: f.id, cwd: f.app, status: "running" });
  const report = await f.deletion.preflight(f.app);
  assert.equal(report.ready, false);
  await assert.rejects(
    f.deletion.endBlockers({ path: f.app, token: "f".repeat(64), sessions: true }, owner),
    { code: "PROJECT_DELETE_STALE" },
  );
  assert.deepEqual(f.calls, []);
  await f.deletion.endBlockers(
    {
      path: f.app,
      token: report.token,
      sessions: true,
      processes: [
        { pid: 101, startTime: "t101" },
        { pid: 102, startTime: "other start" },
        { pid: 103, startTime: "t103" },
        { pid: 104, startTime: "t104" },
      ],
    },
    owner,
  );
  assert.deepEqual(f.ended, [101]);
  assert.deepEqual(f.calls, ["stop:s1", "cancel:r1", "stop:pane"]);
  // The ended work is named in the audit record of the deletion.
  found.splice(0, found.length);
  const after = await f.deletion.preflight(f.app);
  assert.equal(after.ready, true);
  await f.deletion.start({ path: f.app, token: after.token, name: after.name }, owner);
  await f.deletion.settled(f.app);
  assert.deepEqual(f.audits[0].details.endedSessionIds, ["s1", "pane"]);
  assert.deepEqual(f.audits[0].details.endedProcesses, [{ pid: 101, name: "proc101" }]);
});

test("audit project.deleted carries path, nested ids, ended work and the Git flag", async (t) => {
  const dirty = async () => ({
    status: "ok",
    worktrees: [{ path: "x", changes: 2, unpushed: 0, inside: true, checked: true }],
    unpushedBranches: 0,
    worktreesChecked: true,
  });
  const f = await setup(t, { git: dirty });
  const nestedFolder = path.join(f.app, "packages", "lib");
  fs.mkdirSync(nestedFolder, { recursive: true });
  const nested = await f.memory.register(nestedFolder);
  const report = await f.deletion.preflight(f.app);
  assert.equal(report.projects.length, 2);
  await f.deletion.start({ path: f.app, token: report.token, name: report.name }, owner);
  await f.deletion.settled(f.app);
  assert.equal(f.audits.length, 1);
  const [event] = f.audits;
  assert.equal(event.action, "project.deleted");
  assert.equal(event.resourceType, "project");
  assert.equal(event.resourceId, f.id);
  assert.equal(event.projectId, f.id);
  assert.equal(event.source, "user");
  assert.equal(event.outcome, "success");
  assert.deepEqual(event.details, {
    path: f.app,
    nestedProjectIds: [nested.id],
    endedSessionIds: [],
    endedProcesses: [],
    unsavedGitWork: true,
    folderMissing: false,
  });
  assert.equal(f.memory.hasProject(nested.id), false);
});

test("agents switched off leave a failed record that resume finishes later", async (t) => {
  quietLog(t);
  let left = ["agentGrants"];
  const f = await setup(t, { dataLeft: () => left });
  const workflows = f.services.assistantWorkflows;
  const report = await f.deletion.preflight(f.app);
  f.services.assistantWorkflows = null;
  await f.deletion.start({ path: f.app, token: report.token, name: report.name }, owner);
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app).error, AGENTS_OFF);
  assert.equal(fs.existsSync(f.app), false);
  // Without the agents a resume leaves it waiting.
  await f.deletion.resume();
  assert.equal(f.memory.deletions.get(f.app).state, "failed");
  f.services.assistantWorkflows = workflows;
  left = [];
  await f.deletion.resume();
  await f.deletion.settled(f.app);
  assert.equal(f.memory.deletions.get(f.app), null);
  assert.equal(f.audits.length, 1);
});

test("a deletion in progress refuses another start and covers nested folders", async (t) => {
  const f = await setup(t);
  const report = await f.deletion.preflight(f.app);
  f.memory.deletions.mark(f.app, { projectIds: [f.id] });
  for (const target of [f.app, path.join(f.app, "src"), path.dirname(f.app)])
    await assert.rejects(f.deletion.start({ path: target, token: report.token }, owner), {
      code: "PROJECT_DELETING",
    });
});

test("audit details drop what they cannot carry", () => {
  const event = auditEvent({
    action: "project.deleted",
    resourceType: "project",
    source: "user",
    outcome: "success",
    details: {
      path: "relative/path",
      nestedProjectIds: ["ok-1", "bad id", 7],
      endedSessionIds: Array.from({ length: 120 }, (_, i) => `s${i}`),
      endedProcesses: [
        { pid: 1.5, name: "x" },
        { pid: 9, name: `a\nb${"c".repeat(80)}` },
      ],
      unsavedGitWork: "yes",
      folderMissing: false,
    },
  });
  assert.equal(event.details.path, undefined);
  assert.deepEqual(event.details.nestedProjectIds, ["ok-1"]);
  assert.equal(event.details.endedSessionIds.length, 100);
  assert.deepEqual(event.details.endedProcesses, [
    { pid: 9, name: `ab${"c".repeat(62)}` },
  ]);
  assert.equal(event.details.unsavedGitWork, undefined);
  assert.equal(event.details.folderMissing, false);
});

test("an error after the mark clears it and deletes nothing", async (t) => {
  const f = await setup(t);
  const report = await f.deletion.preflight(f.app);
  f.services.assistantWorkflows.revokeProject = () => {
    throw Object.assign(new Error("busy"), { status: 503 });
  };
  await assert.rejects(
    f.deletion.start({ path: f.app, token: report.token, name: report.name }, owner),
    { status: 503 },
  );
  assert.equal(f.memory.deletions.get(f.app), null);
  assert.equal(fs.existsSync(f.app), true);
  assert.equal(f.memory.hasProject(f.id), true);
});
