import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-bridge-")),
    store = new AssistantStore({ dataDir }),
    ledger = new RequestLedger(store.db);
  const agent = store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: true },
  });
  const chat = store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: `agent:${agent.runtimeAgentId}:main`,
  });
  const calls = [];
  const routine = { session: null };
  const assistants = {
    store,
    ledger,
    runtime: { client: { ready: true } },
    routines: {
      runOrigin: (a, key) =>
        a.id === agent.id && key === routine.session
          ? { binding: { id: "binding-1" }, conversation: chat }
          : null,
    },
    workflows: {
      ssh: {
        async invoke(inv, input) {
          calls.push({ inv, input });
          await routine.during?.();
          inv.assertCurrent();
          return { ok: true };
        },
      },
    },
  };
  const bridge = new TeamBridge({ assistants, teams: {}, generation: () => 1 });
  const connection = await bridge.start();
  t.after(async () => {
    await bridge.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const post = (endpoint, body) =>
    fetch(connection.url + endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  async function call(
    sessionKey,
    { action = "ssh", agentId = agent.runtimeAgentId } = {},
  ) {
    const prepared = await post("/prepare", {
      agentId,
      sessionKey,
      toolCallId: "call",
      action,
    });
    if (prepared.status !== 200) return prepared;
    const { ticket } = await prepared.json();
    return post("/invoke", { ticket, action, input: { action: "hosts" } });
  }
  const attempt = (conversationId) => {
    const request = ledger.accept(conversationId, {
      clientRequestId: crypto.randomUUID(),
      text: "Run",
    });
    return ledger.recordAttempt(request.id);
  };
  return { store, ledger, agent, chat, calls, call, attempt, routine };
}

test("an owner turn reaches the SSH service with its attempt", async (t) => {
  const f = await fixture(t);
  const a = f.attempt(f.chat.id);
  const response = await f.call(f.chat.runtimeSessionKey);
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].inv.attemptId, a.id);
  assert.equal(f.calls[0].inv.routine, null);
  assert.equal(f.calls[0].inv.toolCallId, "call");
});

test("permanent members reach SSH, task members never do", async (t) => {
  const f = await fixture(t);
  for (const [lifetime, status] of [
    ["permanent", 200],
    ["task", 403],
  ]) {
    const member = f.store.reserveMember({
      id: `member-${lifetime}`,
      parent: f.agent.id,
      assignment: { name: lifetime, role: "r", assignment: "a" },
      snapshot: { model: { connectionId: "c", modelId: "m" }, instructions: "" },
      teamId: "team",
      lifetime,
    });
    const chat = f.store.saveConversation({
      assistantId: member.id,
      runtimeSessionKey: `agent:${member.runtimeAgentId}:main`,
    });
    f.attempt(chat.id);
    const response = await f.call(chat.runtimeSessionKey, {
      agentId: member.runtimeAgentId,
    });
    assert.equal(response.status, status, lifetime);
  }
});

test("a routine run session without an attempt is admitted only for SSH", async (t) => {
  const f = await fixture(t);
  f.routine.session = `agent:${f.agent.runtimeAgentId}:cron:job-1:run:r1`;
  const response = await f.call(f.routine.session);
  assert.equal(response.status, 200);
  assert.equal(f.calls[0].inv.attemptId, null);
  assert.equal(f.calls[0].inv.routine.binding.id, "binding-1");
  assert.equal(f.calls[0].inv.sessionKey, f.routine.session);
  const propose = await f.call(f.routine.session, { action: "propose" });
  assert.equal(propose.status, 403);
  // Any other session without an attempt is refused.
  assert.equal((await f.call("agent:ap-other:main")).status, 403);
});

test("a routine switched off mid-call is no longer current", async (t) => {
  const f = await fixture(t);
  f.routine.session = `agent:${f.agent.runtimeAgentId}:cron:job-1:run:r1`;
  f.routine.during = () => {
    f.routine.session = null;
  };
  const response = await f.call(`agent:${f.agent.runtimeAgentId}:cron:job-1:run:r1`);
  assert.equal(response.status, 403);
});

test("an archived agent's routine is refused", async (t) => {
  const f = await fixture(t);
  f.routine.session = `agent:${f.agent.runtimeAgentId}:cron:job-1:run:r1`;
  f.store.db
    .prepare(
      "UPDATE assistants SET body=json_set(body,'$.archivedAt','2026-10-16T00:00:00.000Z') WHERE id=?",
    )
    .run(f.agent.id);
  assert.equal((await f.call(f.routine.session)).status, 403);
});
