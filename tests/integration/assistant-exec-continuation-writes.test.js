import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  eventTranscript,
  execContinuationFixture as setup,
} from "../helpers/exec-continuation-fixture.js";
import {
  CompletionRuns,
  continuationSource,
} from "../../server/features/assistants/exec-continuation.js";
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
  f.assistants.completionRuns.observe({
    runId: "wake-1",
    sessionKey: "session",
    stream: "lifecycle",
    data: { phase: "end" },
  });
  assert.equal(await f.call("renders/late.md", { ctx }), false);
});

test("the heartbeat completion of 2026.10.3 still continues", async (t) => {
  // A rollback to 2026.10.3 before commit: its completion is a heartbeat run, with
  // the framed prompt and no hook trigger the plugin would read.
  const f = await setup(t);
  const attemptId = await f.turn({ kind: "owner" });
  const ctx = await f.wake("wake-1", {});
  assert.equal(await f.call("notes.md", { ctx }), true);
  assert.deepEqual(f.writes(), [["notes.md", attemptId]]);
  assert.deepEqual(f.reads, []);
});

test("an event-turn completion of 10.7 continues the owner turn", async (t) => {
  const f = await setup(t);
  const attemptId = await f.turn({ kind: "owner" });
  const ctx = await f.eventTurn();
  assert.equal(await f.call("renders/notes.md", { ctx }), true);
  // The transcript is read once per run: the verified run is live from then on.
  assert.equal(await f.call("MEMORY.md", { ctx, toolName: "edit" }), true);
  assert.deepEqual(f.writes(), [
    ["renders/notes.md", attemptId],
    ["MEMORY.md", attemptId],
  ]);
  assert.deepEqual(f.reads, [
    { method: "sessions.get", params: { key: "session", limit: 200 } },
  ]);
  assert.deepEqual(
    f.assistants.completionRuns.live("session").map((r) => r.runId),
    ["turn-1"],
  );
  // Its agent events carry no mark and keep it; its end ends it.
  const event = { runId: "turn-1", sessionKey: "session", isHeartbeat: false };
  f.assistants.completionRuns.observe({ ...event, stream: "assistant" });
  assert.equal(f.assistants.completionRuns.live("session").length, 1);
  f.assistants.completionRuns.observe({
    ...event,
    stream: "lifecycle",
    data: { phase: "end" },
  });
  assert.equal(await f.call("renders/late.md", { ctx }), false);
  assert.equal(f.reads.length, 1, "an ended run is not read again");
});

test("an event turn writes only when its transcript entry is the exec's own", async (t) => {
  const line = "Exec completed (brisk-or, code 1) :: done";
  const transcript = eventTranscript("turn-1", line);
  const [owner, ownerReply, entry, record] = transcript;
  for (const [name, page] of [
    ["Gateway error", () => Promise.reject(new Error("unavailable"))],
    ["no transcript", []],
    ["entry missing", [owner, ownerReply, record]],
    ["run missing", [owner, ownerReply, entry]],
    [
      "typed by the owner",
      [owner, ownerReply, { ...entry, provenance: owner.provenance }],
    ],
    [
      "another source",
      [
        owner,
        ownerReply,
        { ...entry, provenance: { kind: "internal_system", sourceTool: "task" } },
      ],
    ],
    [
      "more provenance",
      [
        owner,
        ownerReply,
        { ...entry, provenance: { ...entry.provenance, sourceSessionKey: "x" } },
      ],
    ],
    [
      "another process",
      [owner, ownerReply, { ...entry, content: "Exec completed (kind-clo, code 0)" }],
    ],
    [
      "another run's entry",
      [owner, ownerReply, { ...entry, __openclaw: { runId: "x" } }, record],
    ],
    ["not adjacent", [owner, ownerReply, entry, { ...owner }, record]],
    [
      "owner message in between",
      [owner, ownerReply, entry, { ...owner, content: "Also do this." }, record],
    ],
  ]) {
    const f = await setup(t);
    const warnings = [];
    f.bridge.warn = (message) => warnings.push(message);
    await f.turn({ kind: "owner" });
    // A run of its own per case: a refusal is logged once per run and reason.
    const runId = `turn-${name}`;
    const own = (m) => (m === record ? { ...m, __openclaw: { runId } } : m);
    const ctx = await f.eventTurn(runId, {
      line,
      transcript: Array.isArray(page) ? page.map(own) : page,
    });
    assert.equal(await f.call("notes.md", { ctx }), false, name);
    assert.deepEqual(
      warnings.map((w) => w.match(/\((\w+)\)\.$/)?.[1]),
      ["NOT_COMPLETION"],
      name,
    );
    assert.deepEqual(f.assistants.completionRuns.live("session"), [], name);
  }
});

test("concurrent calls of one pending run share one transcript read", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  const ctx = await f.eventTurn();
  const page = f.transcripts.get("session");
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  f.transcripts.set("session", () => gate.then(() => ({ messages: page })));
  const calls = [f.call("a.md", { ctx }), f.call("b.md", { ctx })];
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  assert.deepEqual(await Promise.all(calls), [true, true]);
  assert.equal(f.reads.filter((r) => r.method === "sessions.get").length, 1);
});

test("a run that ends while its transcript is read writes nothing", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  const ctx = await f.eventTurn();
  const page = f.transcripts.get("session");
  f.transcripts.set("session", async () => {
    f.assistants.completionRuns.observe({
      runId: "turn-1",
      sessionKey: "session",
      stream: "lifecycle",
      data: { phase: "end" },
    });
    return { messages: page };
  });
  assert.equal(await f.call("notes.md", { ctx }), false);
  assert.deepEqual(f.assistants.completionRuns.live("session"), []);
  assert.deepEqual(f.writes(), []);
});

test("two completion runs in one transcript each prove their own entry", async (t) => {
  const f = await setup(t);
  const attemptId = await f.turn({ kind: "owner" }, { sessionId: "brisk-orbit" });
  await f.exec(attemptId, { sessionId: "kind-cloud" });
  const first = "Exec completed (brisk-or, code 0) :: one";
  const second = "Exec completed (kind-clo, code 0) :: two";
  const [, , entry1, record1] = eventTranscript("turn-1", first);
  const [owner, ownerReply, entry2, record2] = eventTranscript("turn-2", second);
  const page = [owner, ownerReply, entry1, record1, entry2, record2];
  const one = await f.eventTurn("turn-1", { line: first, transcript: page });
  const two = await f.eventTurn("turn-2", { line: second, transcript: page });
  assert.equal(await f.call("one.md", { ctx: one }), true);
  assert.equal(await f.call("two.md", { ctx: two }), true);
  // Run 2's evidence with run 1's process lines matches neither entry.
  const swapped = eventTranscript("turn-3", second);
  const three = await f.eventTurn("turn-3", {
    line: first,
    transcript: [...page, swapped[2], swapped[3]],
  });
  assert.equal(await f.call("three.md", { ctx: three }), false);
  assert.deepEqual(
    f.writes().map(([file]) => file),
    ["one.md", "two.md"],
  );
});

test("an attemptless run with completion-shaped text but without the Gateway marker writes nothing", async (t) => {
  // A message typed as `Exec completed (…)` is a user turn (`trigger: "user"`), and a
  // turn whose hooks report no trigger is no event turn either.
  for (const trigger of ["user", null, "heartbeat"]) {
    const f = await setup(t);
    await f.turn({ kind: "owner" });
    const ctx = await f.eventTurn("turn-1", {
      line: "Exec completed (brisk-or, code 0) :: typed",
      trigger,
    });
    assert.equal(await f.call("notes.md", { ctx }), false, String(trigger));
    assert.deepEqual(f.reads, [], "nothing is read for it");
    // The refusal is RUN: the same call of a run CompletionRuns knew would pass on.
    const input = { ...ctx, exec: { complete: true, processes: [], completion: null } };
    assert.equal(continuationSource(f.bridge, input), null);
    f.assistants.completionRuns.admit("turn-1", "session");
    assert.equal(continuationSource(f.bridge, input)?.runId, "turn-1");
  }
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
  // Forwarded content arrived before the command finished; that turn started nothing.
  await f.turn({ kind: "owner", forwarded: true }, { exec: false });
  assert.equal(await f.call("notes.md", { ctx: await f.wake() }), false);
  // The owner's own newer message does not end it (AGENTPIER-261).
  const o = await setup(t);
  const source = await o.turn({ kind: "owner" });
  await o.turn({ kind: "owner" }, { exec: false });
  assert.equal(await o.call("notes.md", { ctx: await o.wake() }), true);
  assert.deepEqual(o.writes(), [["notes.md", source]]);
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
  const noted = [];
  f.bridge.noteShared = (key) => noted.push(key);
  const attemptId = await f.turn({ kind: "user", userId: "anna" });
  const ctx = await f.wake();
  assert.equal(await f.call("notes.md", { ctx }), true);
  // A shared agent's memory change notes the completion run under its own key: the
  // owner turn's own shared write keeps `<attempt>:shared-write`.
  assert.equal(await f.call("MEMORY.md", { ctx }), true);
  assert.deepEqual(noted, [`${attemptId}:wake-1:shared-write`]);
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

test("the call's run must be the Gateway's completion run of this session", async (t) => {
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
  // Command output never reaches SSH or the team (shared files: the shares test).
  for (const action of ["ssh", "delegate", "ask", "grant", "routine"])
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

test("event turns are admitted only while they run", () => {
  const runs = new CompletionRuns();
  runs.admit("e1", "s");
  runs.observe({ runId: "e1", sessionKey: "s", isHeartbeat: false, stream: "item" });
  assert.deepEqual(
    runs.live("s").map((r) => r.runId),
    ["e1"],
  );
  runs.observe({ runId: "e1", sessionKey: "x", isHeartbeat: false, stream: "item" });
  assert.deepEqual(runs.live("s"), []);
  // A verification that returns after the run's end admits nothing.
  runs.observe({
    runId: "e2",
    sessionKey: "s",
    stream: "lifecycle",
    data: { phase: "end" },
  });
  runs.admit("e2", "s");
  assert.deepEqual(runs.live("s"), []);
});

test("heartbeat runs are tracked per session and forgotten when they end", () => {
  const runs = new CompletionRuns();
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
