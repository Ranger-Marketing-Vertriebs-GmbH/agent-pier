import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";

test("project grants default empty, are revisioned, and forbid foreign project reads", async (t) => {
  const f = await workflowFixture(t);
  assert.deepEqual(f.workflows.access.get(f.id).projectIds, []);
  await assert.rejects(
    f.workflows.invoke(await f.invocation(), {
      action: "memory_search",
      projectId: f.project.id,
    }),
    { status: 403 },
  );
  const saved = f.workflows.access.save(f.id, f.policy, 0);
  assert.equal(saved.revision, 1);
  assert.throws(() => f.workflows.access.save(f.id, f.policy, 0), { status: 409 });
  const found = await f.workflows.invoke(await f.invocation(), {
    action: "memory_search",
    projectId: f.project.id,
  });
  assert.equal(found.total, 0);
  await assert.rejects(
    f.workflows.invoke(await f.invocation(), {
      action: "memory_search",
      projectId: "foreign",
    }),
    { status: 403 },
  );
});
test("memory proposals write only after immutable approval and preserve native CAS/provenance", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const inv = await f.invocation();
  const input = {
    action: "memory_write",
    projectId: f.project.id,
    title: "Architecture",
    content: "Reuse native components",
  };
  const proposal = await f.workflows.invoke(inv, input);
  assert.equal(proposal.state, "awaiting_approval");
  assert.equal(f.memory.list(f.project.id).total, 0);
  assert.equal((await f.workflows.invoke(inv, input)).id, proposal.id);
  await assert.rejects(f.workflows.invoke(inv, { ...input, content: "Changed" }), {
    status: 409,
  });
  await f.workflows.decide(
    proposal.id,
    { revision: proposal.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  await f.workflows.tick();
  const entry = f.memory.list(f.project.id).items[0];
  assert.equal(entry.provenance.kind, "assistant");
  assert.equal(entry.provenance.assistantId, f.id);
  assert.equal(f.workflows.get(proposal.id).state, "completed");
  assert.equal(entry.revision, 1);
  const stale = await f.workflows.invoke(await f.invocation(), {
    ...input,
    id: entry.id,
    expectedRevision: 1,
  });
  f.memory.write(f.project.id, {
    id: entry.id,
    expectedRevision: 1,
    title: "New",
    content: "Owner edit",
  });
  await f.workflows.decide(
    stale.id,
    { revision: stale.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  assert.equal(f.memory.read(f.project.id, entry.id).content, "Owner edit");
  assert.equal(f.workflows.get(stale.id).state, "failed");
});
test("coding uses existing durable starts and preserves linkage across lost acknowledgement", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  const original = f.services.pipelines.start;
  f.services.pipelines.start = async (...args) => {
    await original(...args);
    throw Error("Lost acknowledgement");
  };
  const proposal = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Implement feature",
  });
  await f.workflows.tick();
  await f.workflows.tick();
  assert.equal(f.starts.length, 1);
  const action = f.workflows.get(proposal.id);
  assert.ok(action.runId);
  assert.equal(action.state, "running");
  f.runs.get(action.runId).status = "completed";
  await f.workflows.tick();
  assert.equal(f.workflows.get(action.id).state, "completed");
});
test("revoked policy and changed pipeline definitions cannot execute approved work", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const input = {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Implement feature",
  };
  const a = await f.workflows.invoke(await f.invocation(), input);
  await f.workflows.decide(
    a.id,
    { revision: a.revision, decision: "approve" },
    { kind: "owner" },
  );
  f.profile.revision++;
  await f.workflows.tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.workflows.get(a.id).state, "failed");
  f.workflows.access.save(f.id, f.policy, 1);
  const b = await f.workflows.invoke(await f.invocation(), input);
  f.workflows.access.save(f.id, { ...f.policy, projectIds: [] }, 2);
  await assert.rejects(
    f.workflows.decide(
      b.id,
      { revision: b.revision, decision: "approve" },
      { kind: "owner" },
    ),
    { status: 403 },
  );
});
test("Telegram approvals and results keep original identity and enqueue once", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const origin = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  };
  const a = await f.workflows.invoke(await f.invocation("code", origin), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Implement feature",
  });
  await f.workflows.tick();
  await f.workflows.tick();
  assert.equal(f.service.outbox.all().length, 1);
  await assert.rejects(
    f.workflows.decide(
      a.id,
      { revision: a.revision, decision: "approve" },
      { ...origin, chatId: "43" },
    ),
    { status: 403 },
  );
  await f.workflows.decide(a.id, { revision: a.revision, decision: "approve" }, origin);
  await f.workflows.tick();
  const current = f.workflows.get(a.id);
  f.runs.get(current.runId).status = "completed";
  await f.workflows.tick();
  await f.workflows.tick();
  const completed = f.service.outbox.all().filter((e) => e.kind === "action-result");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].chatId, "42");
});

test("a post-persistence conflict still recovers the existing coding run", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  const start = f.services.pipelines.start;
  f.services.pipelines.start = async (...args) => {
    await start(...args);
    throw Object.assign(Error("Late conflict"), { status: 409 });
  };
  const a = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "One execution",
  });
  await f.workflows.tick();
  assert.equal(f.workflows.get(a.id).state, "running");
  assert.equal(f.starts.length, 1);
});

test("an unavailable run does not starve independent approved actions", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  const a = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Unavailable run",
  });
  await f.workflows.tick();
  f.runs.delete(f.workflows.get(a.id).runId);
  const b = await f.workflows.invoke(await f.invocation(), {
    action: "memory_write",
    projectId: f.project.id,
    title: "Independent",
    content: "Keep processing",
  });
  await f.workflows.decide(
    b.id,
    { revision: b.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  assert.equal(f.workflows.get(a.id).state, "unknown");
  assert.equal(f.workflows.get(b.id).state, "completed");
});

test("only the owner can acknowledge an uncertain outcome without replay", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  f.services.pipelines.start = async () => {
    throw Error("Unknown start");
  };
  const a = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Uncertain",
  });
  await f.workflows.tick();
  const current = f.workflows.get(a.id);
  assert.equal(current.state, "unknown");
  const decision = { revision: current.revision, decision: "review" };
  await assert.rejects(f.workflows.decide(a.id, decision, { kind: "telegram" }), {
    status: 403,
  });
  await f.workflows.decide(a.id, decision, { kind: "owner" });
  await f.workflows.tick();
  assert.equal(f.workflows.get(a.id).state, "reviewed");
  assert.equal(f.starts.length, 0);
});

test("restart recovers an executing action and never restarts its confirmed pipeline", async (t) => {
  const { AssistantWorkflows } =
    await import("../../server/features/assistants/assistant-workflows.js");
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  const a = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Restart recovery",
  });
  const executing = f.workflows.store.patch(a.id, { state: "executing" });
  await f.workflows.coding.start(executing);
  await f.workflows.close();
  const restarted = new AssistantWorkflows({ services: f.services, autoStart: false });
  t.after(() => restarted.close());
  assert.equal(restarted.get(a.id).state, "unknown");
  await restarted.tick();
  assert.equal(restarted.get(a.id).state, "running");
  assert.equal(f.starts.length, 1);
});

test("memory write recovery reads its receipt without overwriting later owner changes", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const a = await f.workflows.invoke(await f.invocation(), {
    action: "memory_write",
    projectId: f.project.id,
    title: "First",
    content: "Approved text",
  });
  await f.workflows.decide(
    a.id,
    { revision: a.revision, decision: "approve" },
    { kind: "owner" },
  );
  const original = f.memory.write.bind(f.memory);
  f.memory.write = (...args) => {
    const entry = original(...args);
    original(f.project.id, {
      id: entry.id,
      expectedRevision: entry.revision,
      title: "Owner",
      content: "Later owner change",
    });
    throw Error("Lost write acknowledgement");
  };
  await f.workflows.tick();
  assert.equal(f.workflows.get(a.id).state, "completed");
  assert.equal(f.memory.list(f.project.id).items[0].content, "Later owner change");
  assert.equal(f.workflows.get(a.id).result.revision, 1);
});

test("Telegram workflow callbacks approve once and changed destinations block delivery", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const origin = {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: "42",
    userId: "42",
  };
  const a = await f.workflows.invoke(await f.invocation("callback", origin), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Callback test",
  });
  const sends = [];
  f.client.call = async (method, input) => {
    sends.push({ method, input });
    return { message_id: sends.length, chat: { id: 42 } };
  };
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  const handle = sends[0].input.reply_markup.inline_keyboard[0][0].callback_data;
  const update = (user) => ({
    update_id: 2,
    callback_query: {
      id: "callback",
      data: handle,
      from: { id: user, is_bot: false },
      message: { message_id: 1, chat: { id: 42, type: "private" } },
    },
  });
  await f.service.teamActions.receive(f.channel.id, update(43));
  assert.equal(f.workflows.get(a.id).state, "awaiting_approval");
  await f.service.teamActions.receive(f.channel.id, update(42));
  await f.service.teamActions.receive(f.channel.id, update(42));
  assert.equal(f.workflows.get(a.id).state, "approved");
  await f.workflows.tick();
  assert.equal(f.starts.length, 1);
  const c = f.service.store.get(f.channel.id);
  f.service.store.write({ ...c, chatId: "43", userId: "43" }, c.revision);
  const before = sends.length;
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(sends.length, before);
  assert.equal(
    f.service.outbox.pending(f.channel.id)[0].diagnostic,
    "CHANNEL_DESTINATION_CHANGED",
  );
});

test("Telegram approval discloses a full maximum-length task with its metadata", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const task = "x".repeat(65536);
  const a = await f.workflows.invoke(
    await f.invocation("long", {
      kind: "telegram",
      channelId: f.channel.id,
      chatId: "42",
      userId: "42",
    }),
    { action: "coding_start", projectId: f.project.id, pipelineId: f.pipeline.id, task },
  );
  assert.equal(a.state, "awaiting_approval");
  const entry = f.service.outbox.all()[0];
  assert.ok(entry.text.includes(task));
  assert.ok(entry.text.includes(f.project.name));
  assert.ok(entry.parts.length > 1);
});

test("human pipeline gates send an explicit review notice without approving the gate", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  const a = await f.workflows.invoke(
    await f.invocation("human", {
      kind: "telegram",
      channelId: f.channel.id,
      chatId: "42",
      userId: "42",
    }),
    {
      action: "coding_start",
      projectId: f.project.id,
      pipelineId: f.pipeline.id,
      task: "Human gate",
    },
  );
  await f.workflows.tick();
  f.runs.get(f.workflows.get(a.id).runId).status = "awaiting-human";
  await f.workflows.tick();
  const note = f.service.outbox.all().find((e) => e.kind === "action-human");
  assert.match(note.text, /Entscheidung|decision/);
  assert.equal(f.runs.get(f.workflows.get(a.id).runId).status, "awaiting-human");
});

test("a queued tick does not resurrect an outcome reviewed while another action awaits", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  await f.workflows.invoke(await f.invocation("slow"), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Slow start",
  });
  const b = await f.workflows.invoke(await f.invocation("review"), {
    action: "memory_write",
    projectId: f.project.id,
    title: "Saved",
    content: "Already saved",
  });
  f.memory.write(
    f.project.id,
    { title: "Saved", content: "Already saved", requestId: b.id },
    { kind: "assistant", assistantId: f.id, actionId: b.id },
  );
  const unknown = f.workflows.store.patch(b.id, { state: "unknown" });
  let entered, release;
  const waiting = new Promise((r) => (entered = r)),
    held = new Promise((r) => (release = r));
  const start = f.services.pipelines.start;
  f.services.pipelines.start = async (...args) => {
    entered();
    await held;
    return start(...args);
  };
  const ticking = f.workflows.tick();
  await waiting;
  await f.workflows.decide(
    b.id,
    { revision: unknown.revision, decision: "review" },
    { kind: "owner" },
  );
  release();
  await ticking;
  assert.equal(f.workflows.get(b.id).state, "reviewed");
});

test("uncertain coding starts notify Telegram once without retrying execution", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  let calls = 0;
  f.services.pipelines.start = async () => {
    calls++;
    throw Error("Uncertain start");
  };
  const a = await f.workflows.invoke(
    await f.invocation("unknown-channel", {
      kind: "telegram",
      channelId: f.channel.id,
      chatId: "42",
      userId: "42",
    }),
    {
      action: "coding_start",
      projectId: f.project.id,
      pipelineId: f.pipeline.id,
      task: "Uncertain coding",
    },
  );
  await f.workflows.tick();
  await f.workflows.tick();
  assert.equal(f.workflows.get(a.id).state, "unknown");
  assert.equal(calls, 1);
  const notes = f.service.outbox.all().filter((e) => e.kind === "action-unknown");
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /unklar|unknown/);
});
async function completedCoding(f, emit) {
  f.services.assistantRoutines = { emit };
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  const proposal = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Implement feature",
  });
  await f.workflows.tick();
  f.runs.get(f.workflows.get(proposal.id).runId).status = "completed";
  return proposal.id;
}
test("a permanently rejected coding.completed emission is recorded once and never retried", async (t) => {
  const f = await workflowFixture(t);
  let emits = 0;
  const id = await completedCoding(f, async () => {
    emits++;
    throw Object.assign(Error("Forbidden"), { status: 403 });
  });
  await f.workflows.tick();
  await f.workflows.tick();
  assert.equal(emits, 1);
  assert.equal(f.workflows.get(id).state, "completed");
  assert.deepEqual(f.workflows.get(id).eventSkipped, {
    status: 403,
    reason: "FORBIDDEN",
  });
});
test("an unavailable runtime retries coding.completed emission with capped backoff", async (t) => {
  const f = await workflowFixture(t);
  let clock = 0,
    emits = 0,
    ready = false;
  f.workflows.now = () => clock;
  const id = await completedCoding(f, async () => {
    emits++;
    if (!ready) throw Object.assign(Error("Unavailable"), { status: 503 });
    return [];
  });
  await f.workflows.tick();
  assert.equal(emits, 1);
  clock = 1999;
  await f.workflows.tick();
  assert.equal(emits, 1);
  clock = 2000;
  await f.workflows.tick();
  assert.equal(emits, 2);
  for (let n = 0; n < 12; n++) {
    clock = f.workflows.get(id).eventRetryAt;
    await f.workflows.tick();
  }
  assert.equal(emits, 14);
  assert.equal(f.workflows.get(id).eventRetryAt - clock, 300000);
  ready = true;
  clock = f.workflows.get(id).eventRetryAt;
  await f.workflows.tick();
  assert.equal(f.workflows.get(id).eventEmitted, true);
  await f.workflows.tick();
  assert.equal(emits, 15);
});
test("ticks visit only actions with outstanding work", async (t) => {
  const f = await workflowFixture(t);
  const id = await completedCoding(f, async () => []);
  await f.workflows.tick();
  assert.equal(f.workflows.get(id).eventEmitted, true);
  const visited = [];
  const advanceAction = f.workflows.advanceAction.bind(f.workflows);
  f.workflows.advanceAction = (a) => {
    visited.push(a.id);
    return advanceAction(a);
  };
  f.workflows.store.list = () => assert.fail("tick must query only open actions");
  await f.workflows.tick();
  assert.deepEqual(visited, []);
  assert.deepEqual(f.workflows.store.open(), []);
});
