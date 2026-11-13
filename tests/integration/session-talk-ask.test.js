import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { deliveryUuid } from "../../server/features/assistants/coding-sessions/session-steering.js";

const sessionId = "homelab-session";
const question = "give me a free IP";

const until = async (check, what) => {
  for (let i = 0; i < 400; i += 1) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

// The session fixture with a granted "Network Architect" agent, its main chat, a
// running Codex session of the "homelab" project and a runtime whose turns end with
// the reply `answer(attemptId, text)` sets.
async function setup(t) {
  const f = await agentSessionFixture(t);
  const w = f.workflows;
  const talk = w.sessions.talk;
  f.memory.db
    .prepare("UPDATE projects SET name=? WHERE id=?")
    .run("homelab", f.project.id);
  const agent = f.store.createAssistant({
    name: "Network Architect",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const chat = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "architect-main",
  });
  const grant = (talkProjectIds) =>
    w.access.save(
      agent.id,
      { ...f.policy, talkProjectIds },
      w.access.get(agent.id).revision ?? 0,
    );
  grant([f.project.id]);
  f.sessions.set(sessionId, {
    id: sessionId,
    status: "running",
    name: "Homelab deploy",
    tool: "codex",
    accountId: "local-codex",
    cwd: f.cwd,
    createdAt: "2026-11-13T10:00:00.000Z",
    sshTools: { project: { projectId: f.project.id } },
  });
  const replies = new Map();
  f.assistants.history = async () => ({
    stale: false,
    messages: [...replies].map(([runId, text], i) => ({
      id: `m${i}`,
      role: "assistant",
      runId,
      text,
    })),
  });
  // The agent's chat is busy while `busy` is set: sends answer 409.
  const state = { busy: false, sends: 0 };
  const send = f.assistants.send;
  f.assistants.send = async (id, input, context) => {
    if (context?.kind === "session-talk") {
      state.sends += 1;
      if (state.busy) throw Object.assign(Error("busy"), { status: 409, code: "active" });
    }
    return send(id, input, context);
  };
  const audits = [];
  f.services.audit = { append: (event) => audits.push(event) };
  const talkRequests = () =>
    f.assistants.ledger
      .requests(chat.id)
      .filter((r) => r.clientRequestId.startsWith("session-talk:"));
  const dispatched = () =>
    until(() => {
      const request = talkRequests().at(-1);
      return request && f.assistants.ledger.attemptFor(request.id);
    }, "the talk turn");
  const answer = (attemptId, text) => {
    replies.set(attemptId, text);
    f.assistants.ledger.transition(attemptId, "completed");
  };
  return {
    f,
    w,
    talk,
    agent,
    chat,
    grant,
    state,
    audits,
    talkRequests,
    dispatched,
    answer,
  };
}

const ask = (s, options = {}) =>
  s.talk.ask(sessionId, { agentId: s.agent.id, question }, options);
const rowsOf = (s, op) =>
  s.talk.store.forConversation(s.chat.id).filter((r) => r.op === op);

test("ask returns the agent's answer within the wait", async (t) => {
  const s = await setup(t);
  assert.deepEqual(await s.talk.agents(sessionId), {
    agents: [{ agentId: s.agent.id, name: "Network Architect", via: "project" }],
  });
  const pending = ask(s);
  const attempt = await s.dispatched();
  const request = s.talkRequests()[0];
  const context = s.f.contexts.at(-1);
  assert.equal(context.kind, "session-talk");
  assert.equal(context.display, question);
  assert.equal(context.op, "ask");
  assert.equal(context.sessionName, "Homelab deploy");
  assert.equal(context.projectName, "homelab");
  assert.match(request.clientRequestId, /^session-talk:/);
  assert.ok(
    s.f.sent.at(-1).text.startsWith('Coding session "Homelab deploy" (project "homelab"'),
  );
  s.answer(attempt.id, "10.0.0.42 is free");
  await s.talk.tick();
  const result = await pending;
  assert.equal(result.status, "answered");
  assert.equal(result.answer, "10.0.0.42 is free");
  assert.equal(result.truncated, false);
  assert.deepEqual(result.agent, { agentId: s.agent.id, name: "Network Architect" });
  const row = rowsOf(s, "ask")[0];
  assert.equal(row.inline, true);
  assert.equal(row.phase, "answered");
  const audit = s.audits.find((e) => e.action === "session.asked");
  assert.deepEqual(audit.details.sessionTalk, {
    assistantId: s.agent.id,
    op: "ask",
    requestId: row.id,
    via: "project",
    status: "queued",
  });
});

test("the framing marks the session, not the owner", async (t) => {
  const s = await setup(t);
  const pending = ask(s);
  const attempt = await s.dispatched();
  const text = s.f.sent.at(-1).text;
  assert.ok(text.includes("This comes from that coding session, not from the owner."));
  assert.ok(text.includes(`sessionId ${sessionId}) asks you:\n> ${question}\n\n`));
  s.answer(attempt.id, "ok");
  await s.talk.tick();
  await pending;
});

test("an ungranted agent is not found", async (t) => {
  const s = await setup(t);
  s.grant([]);
  await assert.rejects(ask(s), { code: "AGENT_TALK_NOT_FOUND", status: 404 });
  await assert.rejects(s.talk.ask(sessionId, { agentId: s.f.id, question }, {}), {
    code: "AGENT_TALK_NOT_FOUND",
  });
  await assert.rejects(s.talk.ask(sessionId, { agentId: "missing", question }, {}), {
    code: "AGENT_TALK_NOT_FOUND",
  });
  assert.deepEqual(s.talkRequests(), []);
  assert.deepEqual(await s.talk.agents(sessionId), { agents: [] });
});

test("invalid questions are refused before anything is recorded", async (t) => {
  const s = await setup(t);
  for (const bad of ["", "   ", "x".repeat(8001), "a\u0007b", 3])
    await assert.rejects(
      s.talk.ask(sessionId, { agentId: s.agent.id, question: bad }, {}),
      { code: "AGENT_TALK_INVALID", status: 400 },
    );
  assert.deepEqual(s.talk.store.forConversation(s.chat.id), []);
});

test("a busy chat queues the ask", async (t) => {
  const s = await setup(t);
  s.state.busy = true;
  const pending = ask(s);
  await until(() => s.state.sends === 1, "the refused send");
  await s.talk.tick();
  assert.equal(rowsOf(s, "ask")[0].phase, "queued");
  assert.deepEqual(s.talkRequests(), []);
  // The owner's turn ended: the next pass dispatches the queued ask.
  s.state.busy = false;
  await s.talk.tick();
  const attempt = await s.dispatched();
  s.answer(attempt.id, "10.0.0.42 is free");
  await s.talk.tick();
  const result = await pending;
  assert.equal(result.status, "answered");
  assert.equal(result.answer, "10.0.0.42 is free");
});

test("a late answer arrives in the session", async (t) => {
  const s = await setup(t);
  let clock = 0;
  s.talk.now = () => clock;
  const pending = ask(s);
  const attempt = await s.dispatched();
  clock = 110_001;
  await s.talk.tick();
  const result = await pending;
  assert.equal(result.status, "pending");
  assert.equal(result.requestId, rowsOf(s, "ask")[0].id);
  assert.equal(rowsOf(s, "ask")[0].late, true);
  s.answer(attempt.id, "10.0.0.42 is free");
  await s.talk.tick();
  const sent = s.f.services.chatDelivery.sent;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, sessionId);
  assert.ok(
    sent[0].body.text.startsWith(
      '[From agent "Network Architect"] Late answer to: "give me a free IP"',
    ),
  );
  assert.ok(sent[0].body.text.endsWith("\n\n10.0.0.42 is free"));
  assert.equal(
    sent[0].body.deliveryId,
    deliveryUuid(`session-talk-late:${result.requestId}`),
  );
  assert.equal(sent[0].body.submit, true);
  const row = rowsOf(s, "ask")[0];
  assert.equal(row.phase, "late-delivered");
  // The late answer is its own row for the agent's chat; it is pasted only once.
  assert.equal(rowsOf(s, "late")[0].phase, "late-delivered");
  await s.talk.tick();
  assert.equal(sent.length, 1);
});

test("an aborted call turns into a late answer", async (t) => {
  const s = await setup(t);
  const result = await ask(s, { signal: AbortSignal.abort() });
  assert.equal(result.status, "pending");
  const attempt = await s.dispatched();
  s.answer(attempt.id, "10.0.0.42 is free");
  await s.talk.tick();
  const sent = s.f.services.chatDelivery.sent;
  assert.equal(sent.length, 1);
  assert.ok(
    sent[0].body.text.startsWith(
      '[From agent "Network Architect"] Late answer to: "give me a free IP"',
    ),
  );
});

test("a late turn without an answer says so in the session", async (t) => {
  const s = await setup(t);
  await ask(s, { signal: AbortSignal.abort() });
  const attempt = await s.dispatched();
  s.f.assistants.ledger.transition(attempt.id, "failed");
  await s.talk.tick();
  const sent = s.f.services.chatDelivery.sent;
  assert.equal(
    sent[0].body.text,
    `[From agent "Network Architect"] No answer to: "${question}" (the agent's turn ended without one).`,
  );
});

test("no paste after the session stopped", async (t) => {
  const s = await setup(t);
  const result = await ask(s, { signal: AbortSignal.abort() });
  const attempt = await s.dispatched();
  await s.f.services.sessions.stop(sessionId);
  s.answer(attempt.id, "10.0.0.42 is free");
  await s.talk.tick();
  assert.equal(s.talk.store.get(result.requestId).phase, "late-dropped");
  assert.deepEqual(s.f.services.chatDelivery.sent, []);
  assert.equal(rowsOf(s, "late")[0].phase, "late-dropped");
});

test("a revoked grant stops a queued ask", async (t) => {
  const s = await setup(t);
  s.state.busy = true;
  const pending = ask(s);
  await until(() => s.state.sends === 1, "the refused send");
  await s.talk.tick();
  s.grant([]);
  s.state.busy = false;
  await s.talk.tick();
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "GRANT_REVOKED");
  const row = rowsOf(s, "ask")[0];
  assert.equal(row.phase, "failed");
  assert.equal(row.diagnostic, "GRANT_REVOKED");
  assert.deepEqual(s.talkRequests(), []);
});

test("a tell is never pasted back", async (t) => {
  const s = await setup(t);
  const told = await s.talk.tell(sessionId, {
    agentId: s.agent.id,
    message: "IP 10.0.0.42 is now used by host foo",
  });
  assert.equal(told.status, "queued");
  assert.equal(typeof told.requestId, "string");
  const attempt = await s.dispatched();
  const context = s.f.contexts.at(-1);
  assert.equal(context.op, "tell");
  assert.ok(s.f.sent.at(-1).text.includes(") tells you:\n"));
  s.answer(attempt.id, "Noted.");
  await s.talk.tick();
  assert.equal(s.talk.store.get(told.requestId).phase, "answered");
  assert.deepEqual(s.f.services.chatDelivery.sent, []);
  assert.equal(
    s.audits.find((e) => e.action === "session.told").details.sessionTalk.status,
    "queued",
  );
});

test("the seventh message in a minute is limited", async (t) => {
  const s = await setup(t);
  for (let i = 0; i < 6; i += 1)
    await s.talk.tell(sessionId, { agentId: s.agent.id, message: `note ${i}` });
  await assert.rejects(ask(s), (error) => {
    assert.equal(error.code, "AGENT_TALK_LIMIT");
    assert.equal(error.status, 429);
    assert.ok(error.retryAfterSeconds >= 1);
    return true;
  });
  await assert.rejects(ask(s), { code: "AGENT_TALK_LIMIT" });
  assert.equal(rowsOf(s, "limit").length, 1);
  assert.equal(rowsOf(s, "ask").length, 0);
  const limited = s.audits.filter((e) => e.action === "session.asked");
  assert.equal(limited.length, 2);
  assert.equal(limited[0].details.sessionTalk.status, "limited");
  assert.equal(limited[0].outcome, "failure");
});

test("an interrupted ask becomes late after a restart", async (t) => {
  const s = await setup(t);
  await ask(s, { signal: AbortSignal.abort() });
  const row = rowsOf(s, "ask")[0];
  s.talk.store.patch(row.id, { late: false });
  const { SessionTalk } =
    await import("../../server/features/assistants/session-talk/session-talk.js");
  const restarted = new SessionTalk(s.w);
  t.after(() => restarted.close());
  assert.equal(restarted.store.get(row.id).late, true);
});

test("a session id reused by a new session gets no late paste", async (t) => {
  const s = await setup(t);
  const result = await ask(s, { signal: AbortSignal.abort() });
  const attempt = await s.dispatched();
  s.f.sessions.get(sessionId).createdAt = "2026-11-14T08:00:00.000Z";
  s.answer(attempt.id, "10.0.0.42 is free");
  await s.talk.tick();
  assert.equal(s.talk.store.get(result.requestId).phase, "late-dropped");
  assert.deepEqual(s.f.services.chatDelivery.sent, []);
});

test("an answer settled before a restart but never handed over arrives late", async (t) => {
  const s = await setup(t);
  // The process ended right after the turn was observed, before the waiter took it.
  const row = s.talk.store.create({
    op: "ask",
    direction: "to-agent",
    assistantId: s.agent.id,
    agentName: "Network Architect",
    conversationId: s.chat.id,
    sessionId,
    sessionCreatedAt: "2026-11-13T10:00:00.000Z",
    projectId: s.f.project.id,
    sessionName: "Homelab deploy",
    projectName: "homelab",
    tool: "codex",
    via: "project",
    text: question,
    phase: "answered",
    answer: "10.0.0.42 is free",
  });
  const { SessionTalk } =
    await import("../../server/features/assistants/session-talk/session-talk.js");
  const restarted = new SessionTalk(s.w);
  t.after(() => restarted.close());
  assert.equal(restarted.store.get(row.id).late, true);
  await restarted.tick();
  const sent = s.f.services.chatDelivery.sent;
  assert.equal(sent.length, 1);
  assert.ok(
    sent[0].body.text.startsWith('[From agent "Network Architect"] Late answer to:'),
  );
  assert.equal(restarted.store.get(row.id).phase, "late-delivered");
});

test("a row whose turn cannot be read fails and frees the chat", async (t) => {
  const s = await setup(t);
  await ask(s, { signal: AbortSignal.abort() });
  await s.dispatched();
  // The dispatching pass has recorded its attempt.
  await until(() => rowsOf(s, "ask")[0].attemptId, "the recorded attempt");
  const stuck = rowsOf(s, "ask")[0];
  s.talk.store.patch(stuck.id, { attemptId: "missing-attempt" });
  const told = await s.talk.tell(sessionId, { agentId: s.agent.id, message: "note" });
  // Held behind the stuck row for a bounded number of passes only.
  let passes = 0;
  while (s.talk.store.get(stuck.id).phase === "running") {
    assert.equal(s.talk.store.get(told.requestId).phase, "queued");
    assert.ok((passes += 1) <= 5, "the stuck row fails within five passes");
    await s.talk.tick();
  }
  assert.equal(s.talk.store.get(stuck.id).phase, "failed");
  assert.equal(s.talk.store.get(stuck.id).diagnostic, "ADVANCE_FAILED");
  await s.talk.tick();
  assert.equal(s.talk.store.get(told.requestId).phase, "running");
});

test("a queued turn goes to the main chat that replaced the old one", async (t) => {
  const s = await setup(t);
  s.state.busy = true;
  const told = await s.talk.tell(sessionId, { agentId: s.agent.id, message: "note" });
  await until(() => s.state.sends === 1, "the refused send");
  await s.talk.tick();
  s.f.store.updateConversation(s.chat.id, {
    main: false,
    archivedAt: new Date().toISOString(),
  });
  const next = s.f.store.saveConversation({
    assistantId: s.agent.id,
    runtimeSessionKey: "architect-main-2",
  });
  s.state.busy = false;
  await s.talk.tick();
  const request = s.f.assistants.ledger
    .requests(next.id)
    .find((r) => r.clientRequestId === `session-talk:${told.requestId}`);
  assert.ok(request);
  assert.equal(s.talk.store.get(told.requestId).conversationId, next.id);
  assert.deepEqual(
    s.talk.store.forConversation(next.id).map((r) => r.id),
    [told.requestId],
  );
});
