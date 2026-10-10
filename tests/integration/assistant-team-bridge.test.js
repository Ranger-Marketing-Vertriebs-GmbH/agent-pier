import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamStore } from "../../server/features/assistants/team-store.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-bridge-")),
    store = new AssistantStore({ dataDir }),
    ledger = new RequestLedger(store.db),
    teams = new TeamStore({ store });
  const parent = store.createAssistant({
      name: "Parent",
      model: { connectionId: "c", modelId: "m" },
    }),
    chat = store.saveConversation({
      assistantId: parent.id,
      runtimeSessionKey: "agent:fixture:chat",
    });
  const request = ledger.accept(chat.id, { clientRequestId: "first", text: "Team" }),
    attempt = ledger.recordAttempt(request.id);
  const assistants = { store, ledger, runtime: { client: { ready: true } } };
  let generation = 1,
    time = 0;
  const service = {
    propose: (inv, input) => {
      inv.assertCurrent();
      return teams.propose({
        ...input,
        operationId: inv.toolCallId,
        parentAttemptId: inv.attemptId,
        origin: { kind: "owner" },
      });
    },
  };
  const bridge = new TeamBridge({
    assistants,
    teams: service,
    generation: () => generation,
    now: () => time,
  });
  const connection = await bridge.start();
  t.after(async () => {
    await bridge.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const post = (endpoint, body, headers = {}) =>
    fetch(connection.url + endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const prepare = () =>
    post("/prepare", {
      agentId: parent.runtimeAgentId,
      sessionKey: chat.runtimeSessionKey,
      toolCallId: "call",
      action: "propose",
    });
  const input = {
    objective: "Review",
    members: [{ name: "Member", role: "Review", assignment: "Review tests" }],
  };
  return {
    post,
    prepare,
    input,
    bridge,
    connection,
    ledger,
    attempt,
    chat,
    teams,
    retire: () => generation++,
    expire: () => (time = 31000),
  };
}
test("bridge rejects browser, foreign credentials, oversized input and unknown runtime caller", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.post("/prepare", {}, { authorization: "Bearer wrong" })).status,
    401,
  );
  assert.equal(
    (await f.post("/prepare", {}, { origin: "http://localhost" })).status,
    403,
  );
  assert.equal((await f.post("/prepare", { padding: "x".repeat(131073) })).status, 413);
  assert.equal(
    (
      await f.post("/prepare", {
        agentId: "foreign",
        sessionKey: "foreign",
        toolCallId: "call",
        action: "propose",
      })
    ).status,
    403,
  );
  assert.ok(!JSON.stringify(f.bridge.status()).includes(f.connection.token));
});
test("one bridge ticket commits once and rejects changed input", async (t) => {
  const f = await fixture(t),
    { ticket } = await (await f.prepare()).json();
  const body = { ticket, action: "propose", input: f.input };
  const first = await (await f.post("/invoke", body)).json();
  assert.equal(first.phase, "awaiting_approval");
  assert.equal((await (await f.post("/invoke", body)).json()).id, first.id);
  assert.equal(
    (await f.post("/invoke", { ...body, input: { ...f.input, objective: "Changed" } }))
      .status,
    409,
  );
  assert.equal(f.teams.list().length, 1);
});
test("old tickets never borrow a later turn's authority", async (t) => {
  const f = await fixture(t),
    { ticket } = await (await f.prepare()).json();
  f.ledger.transition(f.attempt.id, "completed");
  const next = f.ledger.accept(f.chat.id, { clientRequestId: "later", text: "Later" });
  f.ledger.recordAttempt(next.id);
  assert.equal(
    (await f.post("/invoke", { ticket, action: "propose", input: f.input })).status,
    403,
  );
  assert.equal(f.teams.list().length, 0);
});
for (const mode of ["retire", "expire"])
  test(`bridge ${mode} rejects pending admission`, async (t) => {
    const f = await fixture(t),
      { ticket } = await (await f.prepare()).json();
    f[mode]();
    assert.equal(
      (await f.post("/invoke", { ticket, action: "propose", input: f.input })).status,
      403,
    );
    assert.equal(f.teams.list().length, 0);
  });
test("settled expired tickets are reclaimed without forgetting durable operations", async (t) => {
  const f = await fixture(t),
    { ticket } = await (await f.prepare()).json();
  const result = await (
    await f.post("/invoke", { ticket, action: "propose", input: f.input })
  ).json();
  f.expire();
  const next = await (await f.prepare()).json();
  assert.equal(f.bridge.tickets.size, 1);
  assert.equal(
    (
      await (
        await f.post("/invoke", {
          ticket: next.ticket,
          action: "propose",
          input: f.input,
        })
      ).json()
    ).id,
    result.id,
  );
});
