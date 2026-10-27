import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { wakeText } from "../../server/features/assistants/coding-sessions/session-wakes.js";
import { collectItems } from "../../server/features/inbox/inbox-sources.js";

const failure = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return toolError(error);
  }
  assert.fail("expected the call to fail");
};

async function started(f, inv) {
  const r = await f.call(inv ?? (await f.invocation()), {
    action: "start",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    tool: "claude",
    worktree: false,
  });
  assert.equal(r.state, "running");
  return r.sessionId;
}

const permission = {
  id: "p1",
  kind: "permission",
  source: "claude",
  options: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
  subject: { tool: "Bash", command: "rm -rf build" },
};

// What the real broker's request.answered event tells the agent sessions.
const answeredEvent = (f, sessionId, promptId, actor) =>
  f.workflows.sessions.requestEvent({
    action: "request.answered",
    resourceId: promptId,
    sessionId,
    outcome: "success",
    details: { actor },
  });

test("an escalation waits in the agent chat once and completes when the owner answers", async (t) => {
  const f = await agentSessionFixture(t);
  const events = [];
  f.services.audit = { append: (input) => events.push(auditEvent(input)) };
  const released = [];
  f.services.operationsEvents = { releaseRequest: (id) => released.push(id) };
  const sessionId = await started(f);
  f.addRequest(sessionId, permission);
  const escalate = {
    action: "escalate",
    sessionId,
    promptId: "p1",
    note: "Deleting build output, fine?",
  };
  const first = await f.call(await f.invocation(), escalate);
  assert.equal(first.state, "awaiting_approval");
  assert.ok(first.actionId);
  // Escalating again returns the same action.
  const again = await f.call(await f.invocation(), escalate);
  assert.deepEqual(again, first);
  const action = f.workflows.store.get(first.actionId);
  assert.equal(action.key, `escalate:${sessionId}:p1`);
  assert.equal(action.conversationId, f.channel.conversationId);
  assert.deepEqual(action.payload, {
    action: "session_request",
    sessionId,
    promptId: "p1",
    sessionName: "Claude Code · project",
    kind: "permission",
    title: "Bash",
    note: "Deleting build output, fine?",
  });
  assert.deepEqual(action.telegram, {
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
  });
  assert.deepEqual(released, ["p1"]);
  const pending = f.workflows.pending(f.id);
  assert.deepEqual(
    pending.map((a) => a.id),
    [first.actionId],
  );
  // The agent's own listing marks the prompt as escalated.
  const listed = await f.call(await f.invocation(), { action: "requests", sessionId });
  assert.equal(listed.prompts[0].escalated, true);
  // Audited once, ids and enums only: never the note.
  const audits = events.filter((e) => e.details.agentSession?.op === "escalate");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "session.escalated");
  assert.deepEqual(audits[0].details.agentSession, {
    assistantId: f.id,
    op: "escalate",
    actionId: first.actionId,
    promptId: "p1",
  });
  assert.equal(JSON.stringify(events).includes("Deleting build"), false);

  // Still pending: the tick leaves it waiting.
  await f.workflows.tick();
  assert.equal(f.workflows.store.get(first.actionId).state, "awaiting_approval");
  // The owner answers through the broker.
  await f.services.requests.answer(sessionId, "p1", {
    expectedRevision: 1,
    choice: "allow",
  });
  answeredEvent(f, sessionId, "p1", "owner");
  await f.workflows.tick();
  const done = f.workflows.store.get(first.actionId);
  assert.equal(done.state, "completed");
  assert.deepEqual(done.result, { answeredBy: "owner" });
  // The agent is woken once with who answered (agent-coding-session-wakes.test.js).
  assert.equal(typeof done.followUp.attemptId, "string");
  assert.equal(done.settled, true);
  assert.deepEqual(f.workflows.pending(f.id), []);
  // Escalating the answered prompt again returns the finished action.
  assert.equal((await f.call(await f.invocation(), escalate)).state, "completed");
});

test("escalation input, foreign sessions and answered prompts", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  f.addRequest(sessionId, permission);
  for (const input of [
    { action: "escalate", sessionId },
    { action: "escalate", sessionId, promptId: "p1", note: 3 },
    { action: "escalate", sessionId, promptId: "p1", note: "x".repeat(1001) },
  ])
    assert.equal(
      (await failure(f.call(await f.invocation(), input))).code,
      "INVALID_INPUT",
    );
  // Another agent's session and the owner's own session are never confirmed.
  const other = f.store.createAssistant({
    name: "Other",
    model: { connectionId: "test", modelId: "fixture" },
  });
  await f.services.launch({ tool: "codex", cwd: f.cwd }, false, {
    id: "foreign",
    startedBy: { kind: "agent", assistantId: other.id, name: "Other" },
  });
  f.workflows.sessions.store.insert({
    sessionId: "foreign",
    assistantId: other.id,
    conversationId: f.channel.conversationId,
    projectId: f.project.id,
    origin: { class: "owner" },
    inherited: null,
    worktree: null,
    ended: false,
    createdAt: Date.now(),
  });
  f.addRequest("foreign", { ...permission, id: "pf" });
  const owner = await f.services.launch({ tool: "claude", cwd: f.cwd });
  f.addRequest(owner.id, { ...permission, id: "po" });
  for (const input of [
    { action: "escalate", sessionId: "foreign", promptId: "pf" },
    { action: "escalate", sessionId: owner.id, promptId: "po" },
    // The owner's prompt id under the agent's own session.
    { action: "escalate", sessionId, promptId: "po" },
  ])
    assert.equal((await failure(f.call(await f.invocation(), input))).code, "NOT_FOUND");
  // A prompt that is gone: PROMPT_ANSWERED, naming who answered.
  f.removeRequest("p1");
  answeredEvent(f, sessionId, "p1", "telegram");
  const answered = await failure(
    f.call(await f.invocation(), { action: "escalate", sessionId, promptId: "p1" }),
  );
  assert.equal(answered.code, "PROMPT_ANSWERED");
  assert.match(answered.reason, /telegram/);
  assert.equal(f.workflows.store.list(f.id).filter(isEscalation).length, 0);
});

const isEscalation = (a) => a.payload.action === "session_request";

test("an escalation is never decided as an approval", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  f.addRequest(sessionId, permission);
  const { actionId } = await f.call(await f.invocation(), {
    action: "escalate",
    sessionId,
    promptId: "p1",
  });
  const { revision } = f.workflows.store.get(actionId);
  for (const decision of ["approve", "decline"])
    await assert.rejects(
      f.workflows.decide(actionId, { decision, revision }, { kind: "owner" }),
      (error) => error.status === 400,
    );
  assert.equal(f.workflows.store.get(actionId).state, "awaiting_approval");
});

test("a revoked session's escalation is cancelled", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  f.addRequest(sessionId, permission);
  const { actionId } = await f.call(await f.invocation(), {
    action: "escalate",
    sessionId,
    promptId: "p1",
  });
  const access = f.workflows.access;
  access.save(f.id, { ...f.policy, sessionProjectIds: [] }, access.get(f.id).revision);
  await f.workflows.tick();
  const a = f.workflows.store.get(actionId);
  assert.equal(a.state, "cancelled");
  assert.equal(a.diagnostic, "GRANT_REVOKED");
  assert.equal(a.settled, true);
  assert.deepEqual(f.workflows.pending(f.id), []);
});

test("the owner stopping the session completes its escalation as answered by the session", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  f.addRequest(sessionId, permission);
  const { actionId } = await f.call(await f.invocation(), {
    action: "escalate",
    sessionId,
    promptId: "p1",
  });
  // The broker discards a stopped session's prompts.
  await f.services.sessions.stop(sessionId);
  f.removeRequest("p1");
  await f.workflows.tick();
  const a = f.workflows.store.get(actionId);
  assert.equal(a.state, "completed");
  assert.deepEqual(a.result, { answeredBy: "session" });
});

test("a routine run's escalation waits in the routine chat and shows in the inbox as the request", async (t) => {
  const f = await agentSessionFixture(t);
  const conversation = f.store.saveConversation({
    assistantId: f.id,
    runtimeSessionKey: "routine-chat",
  });
  f.assistants.routines = {
    runOrigin: () => ({
      binding: { id: "binding-1", definition: { name: "R" } },
      conversation,
    }),
  };
  const inv = {
    toolCallId: crypto.randomUUID(),
    sessionKey: "run",
    attemptId: null,
    assertCurrent() {},
    routine: { binding: { id: "binding-1" }, conversation: { assistantId: f.id } },
  };
  const sessionId = await started(f, inv);
  f.addRequest(sessionId, { ...permission, createdAt: new Date().toISOString() });
  const { actionId } = await f.call(
    { ...inv, toolCallId: crypto.randomUUID() },
    { action: "escalate", sessionId, promptId: "p1", note: "Please check" },
  );
  assert.equal(f.workflows.store.get(actionId).conversationId, conversation.id);
  const items = await collectItems(f.services);
  assert.deepEqual(
    items.map((i) => i.type),
    ["approval"],
  );
  const agent = f.store.getAssistant(f.id);
  assert.deepEqual(items[0].escalation, {
    agentId: f.id,
    agentName: agent.name,
    note: "Please check",
  });
  assert.deepEqual(items[0].agent, { id: f.id, name: agent.name });
});

test("who answered an escalation is kept on it, so a restart still names them", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  f.addRequest(sessionId, permission);
  const { actionId } = await f.call(await f.invocation(), {
    action: "escalate",
    sessionId,
    promptId: "p1",
  });
  f.removeRequest("p1");
  answeredEvent(f, sessionId, "p1", "telegram");
  // A restart forgets the in-memory answers before the tick sees the prompt gone.
  f.workflows.sessions.answers.clear();
  await f.workflows.tick();
  const a = f.workflows.store.get(actionId);
  assert.equal(a.state, "completed");
  assert.deepEqual(a.result, { answeredBy: "telegram" });
});

test("a wake for an escalation answered by someone unknown claims no one", () => {
  const text = wakeText("s1", {
    event: "prompt-answered",
    promptId: "p1",
    answeredBy: "session",
    name: "n",
  });
  assert.match(
    text,
    /the prompt p1 you escalated is no longer open; who answered it is unknown\./,
  );
  assert.equal(/answered by/.test(text), false);
});
