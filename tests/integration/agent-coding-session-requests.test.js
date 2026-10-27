import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { toolError, toolReason } from "../../server/features/assistants/tool-errors.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { OperationsEvents } from "../../server/application/operations-events.js";

const failure = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return toolError(error);
  }
  assert.fail("expected the call to fail");
};

async function started(f) {
  const r = await f.call(await f.invocation(), {
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
const question = {
  id: "q1",
  kind: "question",
  source: "codex",
  options: [],
  declinable: true,
  questions: [
    {
      id: "color",
      question: "Which color?",
      options: [{ id: "red", label: "Red" }],
      allowOther: true,
      notes: true,
    },
  ],
};

test("requests lists the session's open prompts and an agent answers one by choice", async (t) => {
  const f = await agentSessionFixture(t);
  const events = [];
  f.services.audit = { append: (input) => events.push(auditEvent(input)) };
  const sessionId = await started(f);
  f.addRequest(sessionId, permission);
  // A prompt already being answered is not offered.
  f.addRequest(sessionId, { ...permission, id: "p0", status: "responding" });
  f.setActivity(sessionId, "waiting");
  const listed = await f.call(await f.invocation(), { action: "requests", sessionId });
  assert.deepEqual(listed, {
    prompts: [
      {
        id: "p1",
        kind: "permission",
        presentation: null,
        revision: 1,
        options: permission.options,
        questions: [],
        subject: permission.subject,
        escalated: false,
      },
    ],
  });
  assert.equal(f.workflows.sessions.store.get(sessionId).seen.state, "waiting");

  const result = await f.call(await f.invocation(), {
    action: "answer",
    sessionId,
    promptId: "p1",
    choice: "allow",
  });
  assert.deepEqual(result, { answered: true });
  assert.deepEqual(f.services.requests.answers, [
    {
      sessionId,
      id: "p1",
      input: { expectedRevision: 1, choice: "allow" },
      handoff: false,
      actor: { kind: "agent", assistantId: f.id },
    },
  ]);
  const audited = events.filter((e) => e.details.agentSession?.op === "answer");
  assert.equal(audited.length, 1);
  assert.equal(audited[0].outcome, "success");
  assert.deepEqual(audited[0].details.agentSession, {
    assistantId: f.id,
    op: "answer",
    promptId: "p1",
  });
  assert.equal(JSON.stringify(events).includes("rm -rf"), false);
});

test("the owner answered first: the agent gets PROMPT_ANSWERED naming the owner", async (t) => {
  const f = await agentSessionFixture(t);
  const events = [];
  f.services.audit = { append: (input) => events.push(auditEvent(input)) };
  const sessionId = await started(f);
  f.addRequest(sessionId, permission);
  // The broker's event reaches the facade through the operations events.
  const operations = new OperationsEvents({
    audit: { append: () => {} },
    notifications: { notify: async () => {} },
    assistants: { workflows: f.workflows },
    intervalMs: 0,
  });
  t.after(() => operations.close());
  f.removeRequest("p1");
  operations.emit({
    action: "request.answered",
    resourceType: "request",
    resourceId: "p1",
    sessionId,
    source: "user",
    outcome: "success",
    details: { kind: "permission", decision: "allow", actor: "owner" },
  });
  assert.equal(f.workflows.sessions.answeredBy("p1"), "owner");
  const error = await failure(
    f.call(await f.invocation(), {
      action: "answer",
      sessionId,
      promptId: "p1",
      choice: "deny",
    }),
  );
  assert.equal(error.code, "PROMPT_ANSWERED");
  assert.equal(error.status, 409);
  assert.ok(error.reason.startsWith(toolReason("PROMPT_ANSWERED")));
  assert.match(error.reason, /Answered by: owner\./);
  assert.equal(f.services.requests.answers.length, 0);
  const audited = events.filter((e) => e.details.agentSession?.op === "answer");
  assert.equal(audited.length, 1);
  assert.equal(audited[0].outcome, "failure");
});

test("a prompt that went stale while answering names who claimed it, else the session", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  f.addRequest(sessionId, permission);
  // The owner claimed it between the agent's read and its answer.
  f.services.requests.answer = async () => {
    throw Object.assign(Error("Request changed"), {
      status: 409,
      stale: true,
      answeredBy: "telegram",
    });
  };
  const input = { action: "answer", sessionId, promptId: "p1", choice: "allow" };
  let error = await failure(f.call(await f.invocation(), input));
  assert.equal(error.code, "PROMPT_ANSWERED");
  assert.match(error.reason, /Answered by: telegram\./);
  // Gone with no answer event: the session itself resolved or dropped it.
  f.removeRequest("p1");
  error = await failure(f.call(await f.invocation(), input));
  assert.equal(error.code, "PROMPT_ANSWERED");
  assert.match(error.reason, /Answered by: session\./);
  // An uncertain delivery is no stale prompt.
  f.addRequest(sessionId, permission);
  f.services.requests.answer = async () => {
    throw Object.assign(Error("Unclear"), { status: 409 });
  };
  error = await failure(f.call(await f.invocation(), input));
  assert.equal(error.code, "CONFLICT");
});

test("a question is answered with answers and free text, or declined", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  f.addRequest(sessionId, question);
  const listed = await f.call(await f.invocation(), { action: "requests", sessionId });
  assert.deepEqual(listed.prompts[0].questions, question.questions);
  await f.call(await f.invocation(), {
    action: "answer",
    sessionId,
    promptId: "q1",
    answers: { color: ["Teal, please"] },
    notes: { color: "Matches the logo" },
  });
  f.addRequest(sessionId, { ...question, id: "q2" });
  await f.call(await f.invocation(), {
    action: "answer",
    sessionId,
    promptId: "q2",
    decline: true,
  });
  assert.deepEqual(
    f.services.requests.answers.map((a) => a.input),
    [
      {
        expectedRevision: 1,
        answers: { color: ["Teal, please"] },
        notes: { color: "Matches the logo" },
      },
      { expectedRevision: 1, decline: true },
    ],
  );
  // Exactly one of choice, answers or decline.
  f.addRequest(sessionId, { ...question, id: "q3" });
  for (const extra of [
    {},
    { choice: "red", answers: { color: ["red"] } },
    { decline: false },
    { answers: ["red"] },
    { choice: "allow", notes: { color: "x" } },
  ])
    assert.equal(
      (
        await failure(
          f.call(await f.invocation(), {
            action: "answer",
            sessionId,
            promptId: "q3",
            ...extra,
          }),
        )
      ).code,
      "INVALID_INPUT",
    );
  assert.equal(f.services.requests.answers.length, 2);
});

test("prompts of another session answer NOT_FOUND", async (t) => {
  const f = await agentSessionFixture(t);
  const sessionId = await started(f);
  // The owner's own session with an open prompt.
  const owner = await f.services.launch({ tool: "claude", cwd: f.cwd });
  f.addRequest(owner.id, permission);
  for (const input of [
    { action: "requests", sessionId: owner.id },
    { action: "answer", sessionId: owner.id, promptId: "p1", choice: "allow" },
    // Its prompt id under the agent's own session.
    { action: "answer", sessionId, promptId: "p1", choice: "allow" },
  ])
    assert.equal((await failure(f.call(await f.invocation(), input))).code, "NOT_FOUND");
  // An answer seen for the owner's prompt names nobody to the agent either.
  f.removeRequest("p1");
  f.workflows.sessions.requestEvent({
    action: "request.answered",
    resourceId: "p1",
    sessionId: owner.id,
    outcome: "success",
    details: { actor: "owner" },
  });
  assert.equal(
    (
      await failure(
        f.call(await f.invocation(), {
          action: "answer",
          sessionId,
          promptId: "p1",
          choice: "allow",
        }),
      )
    ).code,
    "NOT_FOUND",
  );
  assert.equal(f.services.requests.answers.length, 0);
});

test("requestEvent remembers at most 1000 answers and ignores failures", async (t) => {
  const f = await agentSessionFixture(t);
  const sessions = f.workflows.sessions;
  const event = (id, values = {}) => ({
    action: "request.answered",
    resourceId: id,
    sessionId: "s",
    outcome: "success",
    details: { actor: "agent", assistantId: "a1" },
    ...values,
  });
  sessions.requestEvent(event("failed", { outcome: "failure" }));
  assert.equal(sessions.answeredBy("failed"), "session");
  sessions.requestEvent(event("handed", { action: "request.handed-off", details: {} }));
  assert.equal(sessions.answeredBy("handed"), "owner");
  for (let i = 0; i < 1001; i++) sessions.requestEvent(event(`r${i}`));
  assert.equal(sessions.answeredBy("handed"), "session");
  assert.equal(sessions.answeredBy("r0"), "session");
  assert.equal(sessions.answeredBy("r1000"), "agent");
});
