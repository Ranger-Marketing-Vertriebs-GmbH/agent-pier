import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execContinuationFixture as setup } from "../helpers/exec-continuation-fixture.js";
import { HeartbeatRuns } from "../../server/features/assistants/exec-continuation.js";
import { execEvidence } from "../../server/features/assistants/team-plugin/exec-processes.js";

test("an exec completion of an owner turn writes like that turn and is audited", async (t) => {
  const f = await setup(t);
  const attemptId = await f.turn({ kind: "owner" });
  const ctx = await f.wake();
  assert.equal(await f.call("renders/notes.md", { ctx }), true);
  assert.equal(await f.call("MEMORY.md", { ctx, toolName: "edit" }), true);
  assert.deepEqual(f.writes(), [
    ["renders/notes.md", attemptId],
    ["MEMORY.md", attemptId],
  ]);
  // The proof never reads the transcript: the Gateway's record comes with the call.
  assert.deepEqual(f.reads, []);
  // Its run ended: no more writes.
  f.assistants.heartbeatRuns.observe({
    runId: "wake-1",
    sessionKey: "session",
    stream: "lifecycle",
    data: { phase: "end" },
  });
  assert.equal(await f.call("renders/late.md", { ctx }), false);
});

test("a completion of a telegram turn writes too, a forwarded or delegated one never", async (t) => {
  for (const [origin, allowed] of [
    [{ kind: "telegram" }, true],
    [{ kind: "owner", forwarded: true }, false],
    [{ kind: "telegram", forwarded: true }, false],
    [{ kind: "lead-request", requestId: "r1" }, false],
    [{ kind: "team-member" }, false],
    [{ kind: "member-result", requestId: "r1" }, false],
    [{ kind: "team-result" }, false],
    [{ kind: "coding-result" }, false],
    [{ kind: "memory-result" }, false],
    [{ kind: "routine" }, false],
  ]) {
    const f = await setup(t);
    await f.turn(origin);
    assert.equal(await f.call("notes.md", { ctx: await f.wake() }), allowed, origin.kind);
    assert.equal(f.writes().length, allowed ? 1 : 0, origin.kind);
  }
});

test("a newer request ends the continuation", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  // The owner wrote again before the command finished; that turn started nothing.
  await f.turn({ kind: "owner" }, { exec: false });
  assert.equal(await f.call("notes.md", { ctx: await f.wake() }), false);
  // A newer request still running binds the session to its own turn instead.
  const g = await setup(t);
  await g.turn({ kind: "owner" });
  const ctx = await g.wake();
  await g.invocation(randomUUID(), { kind: "lead-request", requestId: "r1" });
  assert.equal(await g.call("notes.md", { ctx }), false);
  assert.deepEqual(g.writes(), []);
});

test("a user who lost the agent continues nothing", async (t) => {
  const userAccess = {
    mode: "shared",
    members: [{ userId: "anna", level: "chat" }],
    released: [],
  };
  const f = await setup(t, { userAccess });
  await f.turn({ kind: "user", userId: "anna" });
  const ctx = await f.wake();
  assert.equal(await f.call("notes.md", { ctx }), true);
  const body = {
    ...f.store.storedAssistant(f.id),
    userAccess: { ...userAccess, members: [] },
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  assert.equal(await f.call("notes.md", { ctx }), false);
});

test("only an exec completion's own prompt continues", async (t) => {
  for (const prompt of [
    "Read HEARTBEAT.md and follow it.",
    "A scheduled reminder has been triggered. The reminder content is:\n\nCall mum",
    // Text that quotes a completion is not one.
    `Forwarded: ${"An async command you ran earlier has completed. The command completion details are:\n\nExec completed (brisk-or, code 0) :: x\n\nTreat this completion"}`,
    "An async command completion event was triggered, but user delivery is disabled for this run.",
  ]) {
    const f = await setup(t);
    await f.turn({ kind: "owner" });
    assert.equal(
      await f.call("notes.md", { ctx: await f.wake("wake-1", { prompt }) }),
      false,
    );
  }
});

test("the call's run must be the Gateway's heartbeat run of this session", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  // A run the Gateway never reported as heartbeat-driven, or reported as another's.
  const ctx = await f.wake("wake-1", { event: { isHeartbeat: false } });
  assert.equal(await f.call("notes.md", { ctx }), false);
  assert.equal(await f.call("notes.md", { ctx: { ...ctx, runId: "made-up" } }), false);
  // Without a run id a write never continues, even with a single live run.
  const g = await setup(t);
  await g.turn({ kind: "owner" });
  const { runId: _runId, ...unnamed } = await g.wake();
  assert.equal(await g.call("notes.md", { ctx: unnamed }), false);
  // Another session's heartbeat run, or another agent.
  const i = await setup(t);
  await i.turn({ kind: "owner" });
  const other = await i.wake("wake-2", { sessionKey: "session-other" });
  assert.equal(
    await i.call("notes.md", { ctx: { ...other, sessionKey: "session" } }),
    false,
  );
  assert.equal(
    await i.call("notes.md", { ctx: { ...(await i.wake()), agentId: "other" } }),
    false,
  );
  assert.deepEqual([...f.writes(), ...g.writes(), ...i.writes()], []);
});

test("a completion outside the window writes nothing", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  const ctx = await f.wake();
  f.bridge.now = () => Date.now() + 3 * 3600000;
  assert.equal(await f.call("notes.md", { ctx }), false);
});

test("project folders follow the same rule, for file actions only", async (t) => {
  const f = await setup(t);
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exec-folder-")));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const project = await f.memory.register(folder);
  f.workflows.access.save(
    f.id,
    { ...f.policy, projectIds: [project.id], projectFiles: { [project.id]: "write" } },
    f.workflows.access.get(f.id).revision,
  );
  f.assistants.config = { writeGuard: () => true };
  // As the plugin prepares a workspace call: its run and the Gateway's record.
  const prepare = (action, runId = "wake-1") =>
    f.bridge.prepare({
      agentId: f.agentId,
      sessionKey: "session",
      toolCallId: randomUUID(),
      action,
      runId,
      exec: execEvidence("session", runId),
    });
  const call = async (input) =>
    f.bridge.invoke({
      ticket: prepare("workspace").ticket,
      action: "workspace",
      input: { projectId: project.id, ...input },
    });
  const attemptId = await f.turn({ kind: "owner" });
  // No heartbeat run yet: nothing is bound.
  await assert.rejects(call({ action: "files_list" }), { status: 403 });
  await f.wake();
  await call({ action: "file_write", path: "out.md", content: "done" });
  assert.equal(fs.readFileSync(path.join(folder, "out.md"), "utf8"), "done");
  const audit = f.audits.find((e) => e.details?.kind === "project-file");
  assert.equal(audit.details.via, "exec-completion");
  assert.equal(audit.details.sourceAttemptId, attemptId);
  // Never coding requests or project memory.
  for (const action of ["coding_start", "memory_write", "memory_search"])
    await assert.rejects(call({ action, pipelineId: f.pipeline.id, task: "x" }), {
      status: 403,
    });
  // Command output never reaches SSH, shared files or the team.
  for (const action of ["ssh", "share_file", "delegate", "ask", "grant", "routine"])
    assert.throws(() => prepare(action), { status: 403 }, action);
  // A call without a run is never bound.
  assert.throws(
    () =>
      f.bridge.prepare({
        agentId: f.agentId,
        sessionKey: "session",
        toolCallId: randomUUID(),
        action: "workspace",
      }),
    { status: 403 },
  );
  // A delegated source turn never reaches the folders.
  const g = await setup(t);
  await g.turn({ kind: "lead-request", requestId: "r1" });
  await g.wake();
  assert.throws(
    () =>
      g.bridge.prepare({
        agentId: g.agentId,
        sessionKey: "session",
        toolCallId: randomUUID(),
        action: "workspace",
        runId: "wake-1",
        exec: execEvidence("session", "wake-1"),
      }),
    { status: 403 },
  );
});

test("heartbeat runs are tracked per session and forgotten when they end", () => {
  const runs = new HeartbeatRuns();
  runs.observe({ runId: "r1", sessionKey: "s", isHeartbeat: true, stream: "item" });
  runs.observe({ runId: "r2", sessionKey: "s", stream: "item" });
  assert.deepEqual(
    runs.live("s").map((r) => r.runId),
    ["r1"],
  );
  // A run reported for another session is no longer trusted.
  runs.observe({ runId: "r1", sessionKey: "x", isHeartbeat: true, stream: "item" });
  assert.deepEqual(runs.live("s"), []);
  runs.observe({ runId: "r3", sessionKey: "s", isHeartbeat: true, stream: "item" });
  runs.observe({
    runId: "r3",
    sessionKey: "s",
    stream: "lifecycle",
    data: { phase: "error" },
  });
  assert.deepEqual(runs.live("s"), []);
});
