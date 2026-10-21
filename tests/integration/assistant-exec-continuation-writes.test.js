import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { nativeWriteGuard } from "../helpers/native-write-guard.js";
import {
  HeartbeatRuns,
  completionEvidence,
  continuationWindowMs,
} from "../../server/features/assistants/exec-continuation.js";

const completion = (
  at,
  provenance = { kind: "internal_system", sourceTool: "exec" },
) => ({
  role: "user",
  content: "[OpenClaw exec completion]",
  provenance,
  __openclaw: { senderIsOwner: false },
  timestamp: at,
});

// The fixture's agent with memory, the plugin's write guard live, OpenClaw's raw
// transcript of its chat served by `sessions.get` and its agent events observed.
async function setup(t, { userAccess } = {}) {
  const f = await workflowFixture(t);
  const body = {
    ...f.store.storedAssistant(f.id),
    capabilities: { memory: true, reminders: false },
    ...(userAccess ? { userAccess } : {}),
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  f.assistants.heartbeatRuns = new HeartbeatRuns();
  const audits = [];
  f.assistants.audit = { append: (event) => audits.push(event) };
  f.services.audit = { append: (event) => audits.push(event) };
  const transcript = [];
  const reads = [];
  f.assistants.runtime.client.call = async (method, params) => {
    reads.push({ method, params });
    return method === "sessions.get" ? { messages: structuredClone(transcript) } : {};
  };
  const guard = await nativeWriteGuard(t, f);
  // An owner turn (or another origin's) that started a background command and ended.
  const turn = async (origin, { exec = true } = {}) => {
    const { attemptId } = await f.invocation(randomUUID(), origin);
    f.assistants.ledger.transition(attemptId, "completed");
    const at = Date.now();
    transcript.push({
      role: "user",
      content: "Render the video",
      idempotencyKey: `${attemptId}:user`,
      timestamp: at,
    });
    if (exec)
      transcript.push(
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "c1", name: "exec", arguments: {} }],
          timestamp: at,
        },
        { role: "toolResult", toolCallId: "c1", toolName: "exec", content: [] },
      );
    return attemptId;
  };
  // OpenClaw's heartbeat run for the completion, as its agent events report it.
  const wake = (runId = "wake-1", extra = {}) => {
    f.assistants.heartbeatRuns.observe({
      runId,
      sessionKey: "session",
      stream: "lifecycle",
      isHeartbeat: true,
      data: { phase: "start" },
      ...extra,
    });
    return { agentId: guard.agentId, sessionKey: "session", runId };
  };
  const writes = () =>
    audits
      .filter((e) => e.details?.via === "exec-completion")
      .map((e) => [e.details.filePath, e.details.sourceAttemptId]);
  return { ...f, ...guard, audits, transcript, reads, turn, wake, writes };
}

test("an exec completion of an owner turn writes like that turn and is audited", async (t) => {
  const f = await setup(t);
  const attemptId = await f.turn({ kind: "owner" });
  f.transcript.push(completion(Date.now()));
  const ctx = f.wake();
  assert.equal(await f.call("renders/notes.md", { ctx }), true);
  assert.equal(await f.call("MEMORY.md", { ctx, toolName: "edit" }), true);
  assert.deepEqual(f.writes(), [
    ["renders/notes.md", attemptId],
    ["MEMORY.md", attemptId],
  ]);
  // The transcript is read once per run; every write re-checks AgentPier's records.
  assert.equal(f.reads.filter((r) => r.method === "sessions.get").length, 1);
  assert.deepEqual(f.reads[0].params, { key: "session", limit: 100 });
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
    f.transcript.push(completion(Date.now()));
    assert.equal(await f.call("notes.md", { ctx: f.wake() }), allowed, origin.kind);
    assert.equal(f.writes().length, allowed ? 1 : 0, origin.kind);
  }
});

test("a newer request ends the continuation", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  // The owner wrote again before the command finished; that turn started nothing.
  await f.turn({ kind: "owner" }, { exec: false });
  f.transcript.push(completion(Date.now()));
  assert.equal(await f.call("notes.md", { ctx: f.wake() }), false);
  // A newer request still running binds the session to its own turn instead.
  const g = await setup(t);
  await g.turn({ kind: "owner" });
  g.transcript.push(completion(Date.now()));
  const ctx = g.wake();
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
  f.transcript.push(completion(Date.now()));
  const ctx = f.wake();
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

test("only an exec completion continues: image results, polls and claims never", async (t) => {
  for (const provenance of [
    { kind: "inter_session", sourceTool: "image_generate" },
    { kind: "internal_system", sourceTool: "image_generate" },
    { kind: "internal_system", sourceTool: "heartbeat" },
    { kind: "internal_system", sourceTool: "cron" },
    { kind: "external_user" },
    null,
  ]) {
    const f = await setup(t);
    await f.turn({ kind: "owner" });
    f.transcript.push(completion(Date.now(), provenance));
    assert.equal(
      await f.call("notes.md", { ctx: f.wake() }),
      false,
      provenance?.sourceTool,
    );
  }
  // An exec completion followed by another internal message is no longer current.
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  f.transcript.push(
    completion(Date.now()),
    completion(Date.now(), { kind: "internal_system", sourceTool: "heartbeat" }),
  );
  assert.equal(await f.call("notes.md", { ctx: f.wake() }), false);
});

test("the plugin's run id alone proves nothing", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  // A run the Gateway never reported as heartbeat-driven, or reported as another's.
  f.wake("wake-1", { isHeartbeat: false });
  const ctx = { agentId: f.agentId, sessionKey: "session", runId: "wake-1" };
  f.transcript.push(completion(Date.now()));
  assert.equal(await f.call("notes.md", { ctx }), false);
  assert.equal(await f.call("notes.md", { ctx: { ...ctx, runId: "made-up" } }), false);
  // A heartbeat run without the completion in the session's transcript.
  const g = await setup(t);
  await g.turn({ kind: "owner" });
  assert.equal(await g.call("notes.md", { ctx: g.wake() }), false);
  // A completion of a command no owner turn started.
  const h = await setup(t);
  await h.turn({ kind: "owner" }, { exec: false });
  h.transcript.push(completion(Date.now()));
  assert.equal(await h.call("notes.md", { ctx: h.wake() }), false);
  // Another session's heartbeat run, or another agent.
  const i = await setup(t);
  await i.turn({ kind: "owner" });
  i.transcript.push(completion(Date.now()));
  const other = i.wake("wake-2", { sessionKey: "session-other" });
  assert.equal(
    await i.call("notes.md", { ctx: { ...other, sessionKey: "session" } }),
    false,
  );
  assert.equal(
    await i.call("notes.md", { ctx: { ...i.wake(), agentId: "other" } }),
    false,
  );
  assert.deepEqual([...f.writes(), ...g.writes(), ...h.writes(), ...i.writes()], []);
});

test("a completion outside the window writes nothing", async (t) => {
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  f.transcript.push(completion(Date.now()));
  const ctx = f.wake();
  f.bridge.now = () => Date.now() + continuationWindowMs + 60000;
  assert.equal(await f.call("notes.md", { ctx }), false);
  // A completion stamped after the window, too.
  const attempt = { id: "a1", createdAt: new Date(0).toISOString() };
  const messages = [
    { role: "user", content: "Go", idempotencyKey: "a1:user", timestamp: 0 },
    { role: "assistant", content: [{ type: "toolCall", name: "exec" }] },
    completion(continuationWindowMs + 1),
  ];
  assert.equal(completionEvidence(messages, attempt), false);
  messages[2] = completion(continuationWindowMs);
  assert.equal(completionEvidence(messages, attempt), true);
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
  const call = async (input) => {
    const { ticket } = await f.bridge.prepare({
      agentId: f.agentId,
      sessionKey: "session",
      toolCallId: randomUUID(),
      action: "workspace",
    });
    return f.bridge.invoke({
      ticket,
      action: "workspace",
      input: { projectId: project.id, ...input },
    });
  };
  const attemptId = await f.turn({ kind: "owner" });
  // No heartbeat run yet: nothing is bound.
  await assert.rejects(call({ action: "files_list" }), { status: 403 });
  f.wake();
  // The run is reported, the transcript has no completion yet.
  await assert.rejects(call({ action: "files_list" }), { status: 403 });
  f.transcript.push(completion(Date.now()));
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
    assert.throws(
      () =>
        f.bridge.prepare({
          agentId: f.agentId,
          sessionKey: "session",
          toolCallId: randomUUID(),
          action,
        }),
      { status: 403 },
      action,
    );
  // Two heartbeat runs at once: which one calls is unknown.
  f.wake("wake-2");
  await assert.rejects(call({ action: "files_list" }), { status: 403 });
  // A delegated source turn never reaches the folders.
  const g = await setup(t);
  await g.turn({ kind: "lead-request", requestId: "r1" });
  g.transcript.push(completion(Date.now()));
  g.wake();
  await assert.rejects(
    (async () =>
      g.bridge.prepare({
        agentId: g.agentId,
        sessionKey: "session",
        toolCallId: randomUUID(),
        action: "workspace",
      }))(),
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
