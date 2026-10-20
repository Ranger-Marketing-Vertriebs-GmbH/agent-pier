import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo } from "../helpers/user-chats.js";
import { notFoundBody } from "../../server/http/responses.js";
import { AgentApprovalEvents } from "../../server/application/agent-approval-events.js";

// An approval waiting in Anna's chat with the shared agent.
async function annasApproval(f) {
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const opened = await as(f, anna.cookie)(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const conversationId = (await opened.json()).id;
  const action = f.application.assistants.workflows.store.reserve({
    key: `approval-${conversationId}`,
    assistantId: agent.id,
    conversationId,
    origin: { kind: "user", userId: anna.user.id },
    payload: { action: "memory_write", projectId: "p", title: "Note", content: "x" },
    state: "awaiting_approval",
  });
  return { anna, ben, agent, action, conversationId };
}

const decide = (request, action, prefix = "/api/me/approvals") =>
  request(`${prefix}/${action.id}/decision`, {
    method: "POST",
    body: { revision: action.revision, decision: "decline" },
  });

test("an approval raised in A's chat goes to A only", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent, action } = await annasApproval(f);
  const listed = await (await as(f, anna.cookie)("/api/me/approvals")).json();
  assert.deepEqual(
    listed.actions.map((a) => a.id),
    [action.id],
  );
  assert.deepEqual(
    (await (await as(f, ben.cookie)("/api/me/approvals")).json()).actions,
    [],
  );
  const byBen = await decide(as(f, ben.cookie), action);
  assert.equal(byBen.status, 404);
  assert.deepEqual(await byBen.json(), notFoundBody());
  const inbox = await (await f.request("/api/inbox")).json();
  assert.ok(!JSON.stringify(inbox).includes(action.id));
  const byOwner = await f.request(`/api/assistant-actions/${action.id}/decision`, {
    method: "POST",
    body: { revision: action.revision, decision: "decline" },
  });
  assert.equal(byOwner.status, 404);
  // The service itself refuses the owner too, whatever route asks.
  await assert.rejects(
    f.application.assistants.workflows.decide(
      action.id,
      { revision: action.revision, decision: "decline" },
      { kind: "owner", channel: "ui" },
    ),
    { status: 404 },
  );
  const ownerList = await (await f.request(`/api/assistants/${agent.id}/actions`)).json();
  assert.deepEqual(ownerList.actions, []);
  // The push goes to Anna's devices, never into the owner's inbox.
  const notices = [];
  const events = new AgentApprovalEvents({
    services: f.application,
    notifications: { notify: async (notice) => notices.push(notice) },
  });
  events.seen = new Set();
  await events.poll();
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].audience, { kind: "user", userId: anna.user.id });
  assert.equal(notices[0].inbox, undefined);
});

test("A's decision is audited with her id", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent, action } = await annasApproval(f);
  const response = await decide(as(f, anna.cookie), action);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(f.application.assistants.workflows.store.get(action.id).state, "declined");
  const [entry] = f.application.audit
    .list({ action: "assistant.answered" })
    .events.filter((e) => e.resourceId === agent.id);
  assert.equal(entry.actorUserId, anna.user.id);
  assert.equal(entry.details.actor, "user");
  assert.equal(entry.outcome, "success");
});
