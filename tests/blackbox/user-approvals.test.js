import test from "node:test";
import assert from "node:assert/strict";
import {
  as,
  chatFixture,
  pairedTelegram,
  sharedAgentOfTwo,
  userAgent,
} from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";
import { AgentApprovalEvents } from "../../server/application/agent-approval-events.js";
import { workspaceContext } from "../../server/features/assistants/workspace-calls.js";

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
  // Nor does the owner's agent list count it as waiting.
  const { activity } = await (await f.request("/api/assistants")).json();
  assert.equal(activity[agent.id].pendingApprovals, 0);
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

test("a user decides her approval from her own bot's buttons", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "extended" }],
  });
  const channel = await pairedTelegram(f, as(f, cookie), agent.id);
  const target = {
    channelId: channel.id,
    chatId: channel.chatId,
    userId: channel.userId,
  };
  const workflows = f.application.assistants.workflows;
  const action = workflows.store.reserve({
    key: `approval-${channel.conversationId}`,
    assistantId: agent.id,
    conversationId: channel.conversationId,
    origin: { kind: "telegram", ...target },
    payload: { action: "memory_write", projectId: "p", title: "Note", content: "x" },
    state: "awaiting_approval",
  });
  // Another chat's button is still refused.
  await assert.rejects(
    workflows.decide(
      action.id,
      { revision: action.revision, decision: "decline" },
      { kind: "telegram", ...target, chatId: "999" },
    ),
    { status: 403 },
  );
  await workflows.decide(
    action.id,
    { revision: action.revision, decision: "decline" },
    { kind: "telegram", ...target },
  );
  assert.equal(workflows.store.get(action.id).state, "declined");
  // Her button's decision is hers in the audit log, not the owner's.
  const entries = f.application.audit
    .list({ action: "assistant.answered" })
    .events.filter((e) => e.resourceId === agent.id && e.outcome === "success");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actorUserId, user.id);
  assert.equal(entries[0].details.actor, "user");
  assert.equal(entries[0].details.channel, "telegram");
});

test("approvals raised in two users' concurrent turns go to whose turn raised them", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const chat = async (user) =>
    (
      await (
        await as(f, user.cookie)(`/api/me/agents/${agent.id}/conversation`, {
          method: "POST",
        })
      ).json()
    ).id;
  const [annaChat, benChat] = [await chat(anna), await chat(ben)];
  const send = async (user, id) => {
    const response = await as(f, user.cookie)(`/api/me/conversations/${id}/messages`, {
      method: "POST",
      body: { clientRequestId: `turn-${id}`, text: "Note this" },
    });
    assert.equal(response.status, 202, await response.clone().text());
    return (await response.json()).attempt.id;
  };
  // Both turns run at once; Ben's started last.
  const [a, b] = await Promise.all([send(anna, annaChat), send(ben, benChat)]);
  const workflows = f.application.assistants.workflows;
  // As workspace-calls.js reserves an approval: from the turn's own context.
  const raise = async (attemptId, name) => {
    const {
      leadRequest: _l,
      routine: _r,
      memberResult: _m,
      ...ctx
    } = workspaceContext(workflows, {
      attemptId,
      toolCallId: `call-${name}`,
      assertCurrent: () => {},
    });
    return workflows.store.reserve({
      ...ctx,
      key: `${attemptId}:call-${name}`,
      payload: { action: "memory_write", projectId: "p", title: name, content: "x" },
      state: "awaiting_approval",
    });
  };
  const [forA, forB] = await Promise.all([raise(a, "annas"), raise(b, "bens")]);
  assert.equal(forA.conversationId, annaChat);
  assert.equal(forB.conversationId, benChat);
  const listed = async (user) =>
    (await (await as(f, user.cookie)("/api/me/approvals")).json()).actions.map(
      (x) => x.id,
    );
  assert.deepEqual(await listed(anna), [forA.id]);
  assert.deepEqual(await listed(ben), [forB.id]);
  assert.equal((await decide(as(f, ben.cookie), forA)).status, 404);
  assert.equal((await decide(as(f, anna.cookie), forA)).status, 200);
});
