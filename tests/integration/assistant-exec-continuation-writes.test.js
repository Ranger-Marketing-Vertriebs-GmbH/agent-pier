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

// OpenClaw 2026.10.3's completion entry: its prompt lists each process by the first
// eight characters of its session (heartbeat-events-filter buildExecEventPrompt).
const prompt = (lines) =>
  "An async command you ran earlier has completed. The command completion details " +
  `are:\n\n${lines.join("\n")}\n\nTreat this completion as an internal continuation.`;
const completion = (
  at,
  provenance = { kind: "internal_system", sourceTool: "exec" },
  lines = ["Exec completed (brisk-or, code 1) :: done"],
) => ({
  role: "user",
  content: "[OpenClaw exec completion]",
  provenance,
  __openclaw: {
    senderIsOwner: false,
    modelPromptProjection: { version: 1, text: prompt(lines) },
  },
  timestamp: at,
});
// An exec call and its result: backgrounded ("running") or finished.
const execCall = (sessionId = "brisk-orbit", status = "running") => [
  {
    role: "assistant",
    content: [{ type: "toolCall", id: "c1", name: "exec", arguments: {} }],
  },
  {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "exec",
    content: [],
    details: { status, sessionId },
  },
];

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
    // Like OpenClaw: only the newest `limit` messages, no paging.
    return method === "sessions.get"
      ? { messages: structuredClone(transcript.slice(-params.limit)) }
      : {};
  };
  const guard = await nativeWriteGuard(t, f);
  // An owner turn (or another origin's) that started a background command and ended.
  const turn = async (origin, { exec = true, sessionId, status } = {}) => {
    const { attemptId } = await f.invocation(randomUUID(), origin);
    f.assistants.ledger.transition(attemptId, "completed");
    const at = Date.now();
    transcript.push({
      role: "user",
      content: "Render the video",
      idempotencyKey: `${attemptId}:user`,
      timestamp: at,
    });
    if (exec) transcript.push(...execCall(sessionId, status));
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
  assert.deepEqual(f.reads[0].params, { key: "session", limit: 200 });
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
    ...execCall(),
    completion(continuationWindowMs + 1),
  ];
  assert.equal(completionEvidence(messages, attempt), false);
  messages[3] = completion(continuationWindowMs);
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

test("a completion credits only processes the owner turn itself started in the background", async (t) => {
  // A forwarded turn starts a background command; the owner's later turn runs a
  // foreground exec; the forwarded turn's command completes.
  const f = await setup(t);
  await f.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  await f.turn({ kind: "owner" }, { sessionId: "calm-wharf", status: "completed" });
  f.transcript.push(completion(Date.now()));
  assert.equal(await f.call("MEMORY.md", { ctx: f.wake() }), false);
  // The owner turn's own background command, while another turn's completes.
  const g = await setup(t);
  await g.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  await g.turn({ kind: "owner" }, { sessionId: "calm-wharf" });
  g.transcript.push(completion(Date.now()));
  assert.equal(await g.call("notes.md", { ctx: g.wake() }), false);
  // Both in one completion: the other turn's process still refuses.
  const h = await setup(t);
  await h.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  await h.turn({ kind: "owner" }, { sessionId: "calm-wharf" });
  h.transcript.push(
    completion(Date.now(), undefined, [
      "Exec completed (calm-wha, code 0) :: built",
      "Exec failed (brisk-or, code 1) :: done",
    ]),
  );
  assert.equal(await h.call("notes.md", { ctx: h.wake() }), false);
  // Its own process alone continues it, also with an earlier other turn's command.
  const i = await setup(t);
  await i.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  const attemptId = await i.turn({ kind: "owner" }, { sessionId: "calm-wharf" });
  i.transcript.push(
    completion(Date.now(), undefined, ["Exec completed (calm-wha, code 0) :: built"]),
  );
  assert.equal(await i.call("notes.md", { ctx: i.wake() }), true);
  assert.deepEqual(i.writes(), [["notes.md", attemptId]]);
  // Two processes with the same first eight characters: which one ended is unknown.
  const j = await setup(t);
  await j.turn({ kind: "owner", forwarded: true }, { sessionId: "calm-wharfish" });
  await j.turn({ kind: "owner" }, { sessionId: "calm-wharf" });
  j.transcript.push(
    completion(Date.now(), undefined, ["Exec completed (calm-wha, code 0) :: built"]),
  );
  assert.equal(await j.call("notes.md", { ctx: j.wake() }), false);
  assert.deepEqual([...f.writes(), ...g.writes(), ...h.writes(), ...j.writes()], []);
});

test("a completion that does not list its processes proves nothing", async (t) => {
  for (const lines of [
    [],
    ["Exec completed (brisk-or, code 1) :: done", "", "[truncated]"],
    ["Exec completed (brisk-or, code 1) :: done", "Some other event"],
    ["exec finished: brisk-or"],
  ]) {
    const f = await setup(t);
    await f.turn({ kind: "owner" });
    f.transcript.push(completion(Date.now(), undefined, lines));
    assert.equal(await f.call("notes.md", { ctx: f.wake() }), false, lines.join("|"));
  }
  // Delivery off: OpenClaw's prompt names no process.
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  const message = completion(Date.now());
  message.__openclaw.modelPromptProjection.text =
    "An async command completion event was triggered, but user delivery is disabled for this run.";
  f.transcript.push(message);
  assert.equal(await f.call("notes.md", { ctx: f.wake() }), false);
  // A failure without output still names its process.
  const g = await setup(t);
  await g.turn({ kind: "owner" });
  g.transcript.push(
    completion(Date.now(), undefined, [
      "Exec failed (brisk-or, code 1) without captured stdout/stderr.",
    ]),
  );
  assert.equal(await g.call("notes.md", { ctx: g.wake() }), true);
});

test("a long owner turn reads a larger bounded tail of its transcript", async (t) => {
  const steps = (n) =>
    Array.from({ length: n }, (_, i) => [
      { role: "assistant", content: [{ type: "toolCall", id: `r${i}`, name: "read" }] },
      { role: "toolResult", toolCallId: `r${i}`, toolName: "read", content: [] },
    ]).flat();
  const f = await setup(t);
  await f.turn({ kind: "owner" });
  f.transcript.push(...steps(150), completion(Date.now()));
  assert.equal(await f.call("notes.md", { ctx: f.wake() }), true);
  assert.deepEqual(
    f.reads.map((r) => r.params.limit),
    [200, 1000],
  );
  // Beyond the bound: refused, and the run never reads again.
  const g = await setup(t);
  await g.turn({ kind: "owner" });
  g.transcript.push(...steps(600), completion(Date.now()));
  const ctx = g.wake();
  assert.equal(await g.call("notes.md", { ctx }), false);
  assert.equal(await g.call("other.md", { ctx }), false);
  assert.deepEqual(
    g.reads.map((r) => r.params.limit),
    [200, 1000],
  );
});

test("a native write names its run, and refusals are logged by code only", async (t) => {
  const f = await setup(t);
  const warnings = [];
  f.bridge.warn = (message) => warnings.push(message);
  await f.turn({ kind: "owner" });
  f.transcript.push(completion(Date.now()));
  const { runId: _runId, ...ctx } = f.wake("wake-unnamed");
  // The single live heartbeat run is not assumed to be the caller.
  assert.equal(await f.call("secret-plan.md", { ctx }), false);
  assert.equal(
    await f.call("secret-plan.md", { ctx: { ...ctx, runId: "wake-unnamed" } }),
    true,
  );
  const h = await setup(t);
  h.bridge.warn = (message) => warnings.push(message);
  await h.turn({ kind: "owner", forwarded: true }, { sessionId: "brisk-orbit" });
  await h.turn({ kind: "owner" }, { exec: false });
  h.transcript.push(completion(Date.now()));
  // A run id of its own: the log keeps one line per session, run and reason.
  const run = h.wake("wake-logged");
  assert.equal(await h.call("secret-plan.md", { ctx: run }), false);
  assert.equal(await h.call("secret-plan.md", { ctx: run }), false);
  t.diagnostic(JSON.stringify(warnings));
  assert.equal(warnings.length, 2, "once per run and reason");
  assert.match(warnings[0], /\(NO_RUN_ID\)\.$/);
  assert.match(warnings[1], /\(PROCESS\)\.$/);
  assert.ok(warnings.every((w) => !w.includes("secret-plan")));
});
