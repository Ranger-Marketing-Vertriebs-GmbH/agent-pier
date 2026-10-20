import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo } from "../helpers/user-chats.js";

// Anna's turn on the shared agent of Anna and Ben, of unknown outcome after a restart.
async function unknownTurn(t) {
  const { f, gateway } = await chatFixture(t);
  const family = await sharedAgentOfTwo(f);
  const request = as(f, family.anna.cookie);
  const { id } = await (
    await request(`/api/me/agents/${family.agent.id}/conversation`, { method: "POST" })
  ).json();
  const sent = await request(`/api/me/conversations/${id}/messages`, {
    method: "POST",
    body: { clientRequestId: "first", text: "Hello" },
  });
  const { attempt } = await sent.json();
  const assistants = f.application.assistants;
  assistants.ledger.transition(attempt.id, "uncertain");
  const settled = async () => {
    await assistants.reconcile();
    return assistants.ledger.getAttempt(attempt.id).reviewedAt !== null;
  };
  const aborted = () =>
    gateway.calls.some(
      (c) => c.method === "sessions.abort" && c.params.runId === attempt.id,
    );
  return { f, ...family, assistants, attempt, settled, aborted };
}

test("a member's unknown turn waits for her own review", async (t) => {
  const { settled, aborted, assistants } = await unknownTurn(t);
  assert.equal(await settled(), false);
  assert.equal(aborted(), false);
  assert.equal(assistants.ledger.pending().length, 1);
});

test("the unknown turn of a user removed from the agent is settled", async (t) => {
  const { f, ben, agent, settled, aborted, assistants } = await unknownTurn(t);
  const removed = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "shared", members: [{ userId: ben.user.id, level: "chat" }] },
      revision: assistants.store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(removed.status, 200, await removed.clone().text());
  assert.equal(await settled(), true);
  assert.ok(aborted(), "her run is aborted before the review");
  assert.deepEqual(assistants.ledger.pending(), []);
});

test("the unknown turn of a disabled user is settled", async (t) => {
  const { f, anna, settled, aborted } = await unknownTurn(t);
  const disabled = await f.request(`/api/users/${anna.user.id}`, {
    method: "PATCH",
    body: { disabled: true },
  });
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.equal(await settled(), true);
  assert.ok(aborted());
});

for (const optIn of [false, true])
  test(`the unknown turn of a deleted user is settled (opt-in ${optIn})`, async (t) => {
    const { f, anna, agent, settled, aborted, assistants } = await unknownTurn(t);
    if (optIn)
      await f.request(`/api/users/${anna.user.id}/owner-may-read`, {
        method: "PUT",
        body: { enabled: true },
      });
    const deleted = await f.request(`/api/users/${anna.user.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 204, await deleted.text());
    assert.equal(await settled(), true);
    assert.ok(aborted());
    assert.deepEqual(assistants.ledger.pending(), []);
    // The shared agent's settings are the owner's to change again.
    const current = assistants.store.getAssistant(agent.id);
    const changed = await f.request(`/api/assistants/${agent.id}`, {
      method: "PATCH",
      body: { name: "Renamed", revision: current.revision },
    });
    assert.equal(changed.status, 200, await changed.clone().text());
  });

test("the owner's unknown turn is settled once the shared agent becomes a user's own", async (t) => {
  const { f, anna, agent, assistants } = await unknownTurn(t);
  const opened = await f.request(`/api/assistants/${agent.id}/conversations`, {
    method: "POST",
  });
  const chat = await opened.json();
  const request = assistants.ledger.accept(chat.id, {
    clientRequestId: "owner",
    text: "Mine",
  });
  const mine = assistants.ledger.recordAttempt(request.id);
  assistants.ledger.transition(mine.id, "uncertain");
  await assistants.reconcile();
  assert.equal(assistants.ledger.getAttempt(mine.id).reviewedAt, null);
  const switched = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "own", members: [{ userId: anna.user.id, level: "chat" }] },
      revision: assistants.store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(switched.status, 200, await switched.clone().text());
  await assistants.reconcile();
  assert.ok(assistants.ledger.getAttempt(mine.id).reviewedAt);
});
