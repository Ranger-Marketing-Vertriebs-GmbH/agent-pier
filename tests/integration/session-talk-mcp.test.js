import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { issue, connect } from "../helpers/session-mcp.js";
import { callTalkTool } from "../../server/features/session-talk/session-talk-mcp.js";

const timeout = 30000;
const errorOf = (result) => JSON.parse(result.content[0].text);

// An app with agents on, a "Network Architect" agent and a running Codex session of
// the fixture project whose agentpier_session grant reads the catalog only.
async function fixture(t, { granted = true } = {}) {
  const f = await applicationFixture(t, enabledAssistants);
  const a = f.application;
  const w = a.assistantWorkflows;
  assert.ok(w, "the agent feature runs");
  const project = await a.memory.register(f.project);
  const agent = a.assistants.store.createAssistant({
    name: "Network Architect",
    model: { connectionId: "c", modelId: "m" },
  });
  if (granted)
    w.access.save(
      agent.id,
      {
        projectIds: [project.id],
        pipelineIds: [],
        memoryWrite: false,
        autonomous: false,
        publish: false,
        talkProjectIds: [project.id],
      },
      w.access.get(agent.id).revision ?? 0,
    );
  const issued = await issue(f, {
    session: { sshTools: { project: { projectId: project.id } } },
  });
  return { f, a, w, agent, issued };
}

test("the server instructions explain the agent header", { timeout }, async (t) => {
  const { f, issued } = await fixture(t);
  const client = await connect(t, f, issued);
  const instructions = client.getInstructions();
  assert.match(instructions, /\[From agent "<name>"\] Late answer to:/);
  assert.match(instructions, /comes from that agent, not from the user/);
});

test(
  "agents_list answers the granted agents over the session socket",
  { timeout },
  async (t) => {
    const { f, agent, issued } = await fixture(t);
    const client = await connect(t, f, issued);
    const listed = await client.callTool({ name: "agents_list", arguments: {} });
    assert.equal(listed.isError, undefined, JSON.stringify(listed));
    assert.deepEqual(listed.structuredContent, {
      agents: [{ agentId: agent.id, name: "Network Architect", via: "project" }],
    });
  },
);

test(
  "without a talk grant agents_list is empty and the agent is not found",
  { timeout },
  async (t) => {
    const { f, agent, issued } = await fixture(t, { granted: false });
    const client = await connect(t, f, issued);
    const listed = await client.callTool({ name: "agents_list", arguments: {} });
    assert.deepEqual(listed.structuredContent, { agents: [] });
    const asked = await client.callTool({
      name: "agent_ask",
      arguments: { agentId: agent.id, question: "give me a free IP" },
    });
    assert.equal(asked.isError, true);
    assert.equal(errorOf(asked).code, "AGENT_TALK_NOT_FOUND");
    assert.equal(errorOf(asked).status, 404);
    const told = await client.callTool({
      name: "agent_tell",
      arguments: { agentId: "unknown", message: "IP 10.0.0.42 is used" },
    });
    assert.equal(errorOf(told).code, "AGENT_TALK_NOT_FOUND");
  },
);

test(
  "agent_ask returns the answer and hands the call's signal on",
  { timeout },
  async (t) => {
    const { f, w, agent, issued } = await fixture(t);
    const calls = [];
    w.sessions.talk.ask = async (sessionId, input, options) => {
      calls.push({ sessionId, input, options });
      return {
        status: "answered",
        agent: { agentId: agent.id, name: "Network Architect" },
        answer: "10.0.0.42 is free",
        truncated: false,
      };
    };
    const client = await connect(t, f, issued);
    const asked = await client.callTool({
      name: "agent_ask",
      arguments: { agentId: agent.id, question: "give me a free IP" },
    });
    assert.equal(asked.isError, undefined, JSON.stringify(asked));
    assert.equal(asked.structuredContent.answer, "10.0.0.42 is free");
    assert.equal(calls[0].sessionId, issued.session.id);
    assert.deepEqual(calls[0].input, {
      agentId: agent.id,
      question: "give me a free IP",
    });
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    // The response was written: the signal never aborted.
    assert.equal(calls[0].options.signal.aborted, false);
    const invalid = await client.callTool({
      name: "agent_ask",
      arguments: { agentId: agent.id, question: "" },
    });
    assert.equal(invalid.isError, true);
  },
);

test(
  "a revoked capability or agents switched off make talk unavailable",
  { timeout },
  async (t) => {
    const { a, agent, issued } = await fixture(t);
    const sessionId = issued.session.id;
    const grant = a.sessionMcp.check(issued.token).extra.grant;
    const input = { agentId: agent.id, message: "IP 10.0.0.42 is used" };
    // A capability that no longer holds, though the grant is still on record.
    const stale = {
      sessionId,
      revalidateSession: () => {
        throw new Error("revoked");
      },
    };
    await assert.rejects(a.mcpTools.call("agent_tell", input, grant, null, stale), {
      code: "AGENT_TALK_UNAVAILABLE",
      status: 403,
    });
    // Agents switched off: nothing to list, nobody to ask.
    const off = { ...a, assistantWorkflows: null };
    const context = { sessionId, revalidateSession: () => {} };
    assert.deepEqual(await callTalkTool(off, "agents_list", {}, context), { agents: [] });
    await assert.rejects(callTalkTool(off, "agent_tell", input, context), {
      code: "AGENT_TALK_UNAVAILABLE",
      status: 503,
    });
    await a.sessionMcp.revoke(sessionId);
    await assert.rejects(a.mcpTools.call("agent_tell", input, grant, null, context), {
      code: "AGENT_TALK_UNAVAILABLE",
      status: 403,
    });
  },
);

test(
  "a client gone before the answer aborts the ask's signal",
  { timeout },
  async (t) => {
    const { a, w, agent, issued } = await fixture(t);
    let entered, aborted;
    const started = new Promise((resolve) => (entered = resolve));
    const ended = new Promise((resolve) => (aborted = resolve));
    w.sessions.talk.ask = (_sessionId, _input, { signal }) => {
      entered();
      return new Promise((resolve) =>
        signal.addEventListener("abort", () => {
          aborted();
          resolve({ status: "pending", requestId: "r", agent: { agentId: agent.id } });
        }),
      );
    };
    const request = http.request({
      socketPath: a.sessionMcp.socketPath,
      path: "/mcp",
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      },
    });
    request.on("error", () => {});
    request.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "agent_ask",
          arguments: { agentId: agent.id, question: "give me a free IP" },
        },
      }),
    );
    await started;
    request.destroy();
    await ended;
  },
);

test("a waiting ask holds back no other call of the session", { timeout }, async (t) => {
  const { f, w, agent, issued } = await fixture(t);
  let entered, release;
  const started = new Promise((resolve) => (entered = resolve));
  const gate = new Promise((resolve) => (release = resolve));
  w.sessions.talk.ask = async () => {
    entered();
    await gate;
    return { status: "pending", requestId: "r", agent: { agentId: agent.id } };
  };
  const client = await connect(t, f, issued);
  const asked = client.callTool({
    name: "agent_ask",
    arguments: { agentId: agent.id, question: "give me a free IP" },
  });
  await started;
  const listed = await client.callTool({ name: "agents_list", arguments: {} });
  assert.equal(listed.structuredContent.agents[0].agentId, agent.id);
  release();
  assert.equal((await asked).structuredContent.status, "pending");
});

test(
  "a cancelled ask ends its wait and its answer turns late",
  { timeout },
  async (t) => {
    const { f, a, w, agent, issued } = await fixture(t);
    a.assistants.store.saveConversation({
      assistantId: agent.id,
      runtimeSessionKey: "architect-main",
    });
    const talk = w.sessions.talk;
    // The turn is never dispatched here; only the wait and its end are under test.
    talk.tick = async () => {};
    const client = await connect(t, f, issued);
    const controller = new AbortController();
    const asked = client.callTool(
      {
        name: "agent_ask",
        arguments: { agentId: agent.id, question: "give me a free IP" },
      },
      undefined,
      { signal: controller.signal },
    );
    asked.catch(() => {});
    const row = () =>
      talk.store
        .forConversation(talk.store.pending()[0]?.conversationId ?? "")
        .find((r) => r.op === "ask");
    for (let i = 0; i < 400 && !row(); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(row().late, undefined);
    // The CLI drops the call (user interrupt): it sends notifications/cancelled.
    controller.abort();
    await assert.rejects(asked);
    for (let i = 0; i < 400 && !row().late; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(row().late, true, "the answer reaches the session as a late answer");
    // The session's other calls still answer.
    const listed = await client.callTool({ name: "agents_list", arguments: {} });
    assert.equal(listed.isError, undefined);
  },
);

test("asking and telling are not marked destructive", { timeout }, async (t) => {
  const { f, issued } = await fixture(t);
  const client = await connect(t, f, issued);
  const tools = Object.fromEntries(
    (await client.listTools()).tools.map((tool) => [tool.name, tool.annotations]),
  );
  for (const name of ["agent_ask", "agent_tell"]) {
    assert.equal(tools[name].destructiveHint, false, name);
    assert.equal(tools[name].readOnlyHint, false, name);
    assert.equal(tools[name].openWorldHint, true, name);
  }
  assert.equal(tools.agents_list.readOnlyHint, true);
});
