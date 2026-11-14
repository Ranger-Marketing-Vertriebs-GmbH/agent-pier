import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { issue, connect } from "../helpers/session-mcp.js";
import { conversationHistory } from "../../server/features/assistants/conversations.js";

const timeout = 60000;
const question = "give me a free IP";

const until = async (check, what) => {
  for (let i = 0; i < 1000; i += 1) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
};

// The whole app (HTTP routes, the session MCP socket, real tmux sessions, the grant
// files and the audit) with a fake agent runtime: a turn sent to an agent is accepted
// in the real ledger with its trusted context, as sendTurn records it, and ends with
// the reply `answer(attemptId, text)` sets; the runtime's transcript of each chat is
// what `transcript` holds. Chat delivery into a session is recorded, not pasted.
async function setup(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const a = f.application;
  const w = a.assistantWorkflows;
  assert.ok(w, "the agent feature runs");
  const assistants = a.assistants;
  const project = await a.memory.register(f.project);
  const agent = (name) => {
    const created = assistants.store.createAssistant({
      name,
      model: { connectionId: "c", modelId: "m" },
    });
    const chat = assistants.store.saveConversation({
      assistantId: created.id,
      runtimeSessionKey: `${created.id}-main`,
    });
    return { ...created, chat };
  };
  const contexts = [];
  const replies = new Map();
  assistants.send = async (conversationId, input, context = { kind: "owner" }) => {
    const request = assistants.ledger.accept(conversationId, input);
    let attempt = assistants.ledger.attemptFor(request.id);
    if (!attempt) {
      assistants.teams.store.recordContext(request.id, context);
      contexts.push({ conversationId, input, context });
      attempt = assistants.ledger.recordAttempt(request.id);
      assistants.ledger.transition(attempt.id, "accepted");
    }
    return { request, attempt };
  };
  assistants.history = async () => ({
    stale: false,
    messages: [...replies].map(([runId, text], i) => ({
      id: `m${i}`,
      role: "assistant",
      runId,
      text,
    })),
  });
  const answer = (attemptId, text) => {
    replies.set(attemptId, text);
    assistants.ledger.transition(attemptId, "completed");
  };
  const pasted = [];
  w.s.chatDelivery = {
    async status(_id, deliveryId) {
      return { deliveryId, status: "absent" };
    },
    async send(sessionId, body) {
      pasted.push({ sessionId, body: structuredClone(body) });
      return { deliveryId: body.deliveryId, status: "accepted" };
    },
  };
  const audits = [];
  const append = w.s.audit.append.bind(w.s.audit);
  w.s.audit.append = (event) => {
    audits.push(event);
    return append(event);
  };
  // One turn of the agent's own main chat, as the owner's, for its tool calls.
  const turn = async (target) => {
    const key = crypto.randomUUID();
    const { attempt } = await assistants.send(target.chat.id, {
      clientRequestId: key,
      text: "Tell the session",
    });
    return { attemptId: attempt.id, toolCallId: key, assertCurrent() {} };
  };
  const coding = async (target, input) => w.sessions.invoke(await turn(target), input);
  const access = async (target, fields) => {
    const current = await (await f.request(`/api/assistants/${target.id}/access`)).json();
    const response = await f.request(`/api/assistants/${target.id}/access`, {
      method: "PUT",
      body: {
        projectIds: [project.id],
        pipelineIds: [],
        memoryWrite: false,
        autonomous: false,
        publish: false,
        sessionProjectIds: [project.id],
        ...fields,
        revision: current.revision ?? 0,
      },
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  return { f, a, w, project, agent, contexts, answer, pasted, audits, coding, access };
}

test(
  "a session and an agent talk through a project grant and a session grant",
  { timeout },
  async (t) => {
    const s = await setup(t);
    const { f, a, w, project } = s;
    const architect = s.agent("Network Architect");
    const planner = s.agent("Planner");
    const outsider = s.agent("Outsider");
    a.memory.db
      .prepare("UPDATE projects SET name=? WHERE id=?")
      .run("homelab", project.id);

    // The owner lets the project's sessions talk to the architect.
    const saved = await s.access(architect, { talkProjectIds: [project.id] });
    assert.deepEqual(saved.talkProjectIds, [project.id]);
    await s.access(planner, { talkProjectIds: [] });
    await s.access(outsider, { talkProjectIds: [] });

    const issued = await issue(f, {
      session: {
        name: "Homelab deploy",
        sshTools: { project: { projectId: project.id } },
      },
    });
    const sessionId = issued.session.id;
    const client = await connect(t, f, issued);

    // The session sees the architect, and only it.
    const listed = await client.callTool({ name: "agents_list", arguments: {} });
    assert.equal(listed.isError, undefined, JSON.stringify(listed));
    assert.deepEqual(listed.structuredContent, {
      agents: [{ agentId: architect.id, name: "Network Architect", via: "project" }],
    });

    // The session asks; the agent's main chat takes the turn and answers.
    const asked = client.callTool({
      name: "agent_ask",
      arguments: { agentId: architect.id, question },
    });
    const sent = await until(
      () => s.contexts.find((c) => c.context.kind === "session-talk"),
      "the session's turn",
    );
    assert.equal(sent.conversationId, architect.chat.id);
    assert.equal(sent.context.op, "ask");
    assert.equal(sent.context.display, question);
    assert.equal(sent.context.sessionName, "Homelab deploy");
    assert.equal(sent.context.projectName, "homelab");
    // The session's text is fenced after the real header.
    assert.ok(
      sent.input.text.startsWith('Coding session "Homelab deploy" (project "homelab"'),
    );
    assert.ok(sent.input.text.includes(`asks you:\n> ${question}\n\n`));
    const request = a.assistants.ledger
      .requests(architect.chat.id)
      .find((r) => r.clientRequestId === sent.input.clientRequestId);
    const attempt = a.assistants.ledger.attemptFor(request.id);
    s.answer(attempt.id, "10.0.0.42 is free");
    await w.sessions.talk.tick();
    const result = await asked;
    assert.equal(result.isError, undefined, JSON.stringify(result));
    assert.equal(result.structuredContent.status, "answered");
    assert.equal(result.structuredContent.answer, "10.0.0.42 is free");

    // The agent's main chat shows the session's turn as the session's, not the owner's.
    a.assistants.store.cacheMessages(architect.chat.id, [
      {
        id: "turn-1",
        role: "user",
        text: sent.input.text,
        timestamp: Date.parse(request.createdAt) + 1,
        runId: null,
      },
    ]);
    const history = await conversationHistory(a.assistants, architect.chat.id);
    const turn = history.messages.find((m) => m.id === "turn-1");
    assert.equal(turn.source, "session");
    assert.deepEqual(turn.sender, {
      kind: "session",
      name: "Homelab deploy",
      project: "homelab",
      op: "ask",
    });
    assert.equal(turn.text, question);

    // The agent writes back to the session: its text is fenced under the header.
    const delivered = await s.coding(architect, {
      action: "send",
      sessionId,
      text: "10.0.0.42 is reserved for you",
    });
    assert.equal(delivered.status, "accepted");
    assert.equal(s.pasted.length, 1);
    assert.equal(s.pasted[0].sessionId, sessionId);
    const lines = s.pasted[0].body.text.split("\n");
    assert.equal(lines[0], '[From agent "Network Architect"]');
    assert.equal(lines[1], "> 10.0.0.42 is reserved for you");
    assert.match(lines.at(-1), /^\(AgentPier: this message is from the agent /);

    // Both directions are audited, with the grant they went through.
    const asks = s.audits.filter((e) => e.action === "session.asked");
    assert.equal(asks.length, 1);
    assert.equal(asks[0].details.sessionTalk.via, "project");
    const sends = s.audits.filter((e) => e.action === "session.sent");
    assert.equal(sends.length, 1);
    assert.equal(sends[0].details.agentSession.via, "project");
    assert.equal(JSON.stringify(s.audits).includes("10.0.0.42"), false);

    // An agent without a grant sees nothing.
    const none = await s.coding(outsider, { action: "list" });
    assert.equal(
      none.sessions.some((x) => x.sessionId === sessionId),
      false,
    );

    // The owner grants the planner to this one session.
    const put = await f.request(`/api/sessions/${sessionId}/agent-accesses`, {
      method: "PUT",
      body: { assistantIds: [planner.id] },
    });
    assert.equal(put.status, 200, await put.clone().text());
    const grantFile = path.join(f.dataDir, "session-talk", "grants", `${sessionId}.json`);
    assert.ok(fs.existsSync(grantFile));
    const both = await client.callTool({ name: "agents_list", arguments: {} });
    assert.deepEqual(
      both.structuredContent.agents.map((x) => [x.name, x.via]),
      [
        ["Network Architect", "project"],
        ["Planner", "session"],
      ],
    );
    const granted = await s.coding(planner, { action: "list" });
    assert.deepEqual(
      granted.sessions.filter((x) => x.sessionId === sessionId).map((x) => x.via),
      ["session"],
    );

    // Stopping the session ends its own grant: the agents no longer reach it.
    const stopped = await f.request(`/api/sessions/${sessionId}/stop`, {
      method: "POST",
    });
    assert.equal(stopped.status, 200, await stopped.clone().text());
    await until(() => !fs.existsSync(grantFile), "the grant file to go");
    for (const target of [planner, architect]) {
      const after = await s.coding(target, { action: "list" });
      assert.equal(
        after.sessions.some((x) => x.sessionId === sessionId && x.status === "running"),
        false,
        target.name,
      );
    }
    assert.equal(
      (await s.coding(planner, { action: "list" })).sessions.some(
        (x) => x.sessionId === sessionId,
      ),
      false,
    );
  },
);

test("a session without any grant lists no agents", { timeout }, async (t) => {
  const s = await setup(t);
  const { f, project } = s;
  const architect = s.agent("Network Architect");
  await s.access(architect, { talkProjectIds: [] });
  const issued = await issue(f, {
    session: { sshTools: { project: { projectId: project.id } } },
  });
  const client = await connect(t, f, issued);
  const listed = await client.callTool({ name: "agents_list", arguments: {} });
  assert.deepEqual(listed.structuredContent, { agents: [] });
  const asked = await client.callTool({
    name: "agent_ask",
    arguments: { agentId: architect.id, question },
  });
  assert.equal(asked.isError, true);
  assert.equal(JSON.parse(asked.content[0].text).code, "AGENT_TALK_NOT_FOUND");
  const seen = await s.coding(architect, { action: "list" });
  assert.equal(
    seen.sessions.some((x) => x.sessionId === issued.session.id),
    false,
  );
});
