import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { mainConversation } from "../../server/features/assistants/routine-targets.js";

test("two users get separate native sessions on a shared agent", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { anna, ben, agent } = await sharedAgentOfTwo(f);
  const assistants = f.application.assistants;
  const a = await assistants.openConversation(agent.id, { userId: anna.user.id });
  const b = await assistants.openConversation(agent.id, { userId: ben.user.id });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.runtimeSessionKey, b.runtimeSessionKey);
  assert.equal(a.userId, anna.user.id);
  assert.equal(b.userId, ben.user.id);
  assert.deepEqual(
    gateway.created.map((c) => c.label),
    [`AgentPier ${agent.id} ${anna.user.id}`, `AgentPier ${agent.id} ${ben.user.id}`],
  );
  const store = assistants.store;
  assert.equal(mainConversation(store, agent.id, anna.user.id).id, a.id);
  assert.equal(mainConversation(store, agent.id, ben.user.id).id, b.id);
  assert.equal(mainConversation(store, agent.id), null);
});

test("opening twice returns the same conversation", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { anna, agent } = await sharedAgentOfTwo(f);
  const assistants = f.application.assistants;
  const first = await assistants.openConversation(agent.id, { userId: anna.user.id });
  const again = await assistants.openConversation(agent.id, { userId: anna.user.id });
  assert.equal(again.id, first.id);
  assert.equal(gateway.created.length, 1);
});

test("the owner has his own chat on a shared agent", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { anna, agent } = await sharedAgentOfTwo(f);
  const assistants = f.application.assistants;
  const user = await assistants.openConversation(agent.id, { userId: anna.user.id });
  const opened = await f.request(`/api/assistants/${agent.id}/conversations`, {
    method: "POST",
  });
  assert.equal(opened.status, 200);
  const owner = await opened.json();
  assert.notEqual(owner.id, user.id);
  assert.equal(owner.userId, undefined);
  assert.equal(gateway.created.at(-1).label, `AgentPier ${agent.id}`);
});

test("the owner cannot open a user's own agent", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "chat" }],
  });
  const opened = await f.request(`/api/assistants/${agent.id}/conversations`, {
    method: "POST",
  });
  assert.equal(opened.status, 404);
  assert.equal(gateway.created.length, 0);
  // A user who is not one of its users cannot open it either.
  await assert.rejects(
    f.application.assistants.openConversation(agent.id, { userId: "someone" }),
    { status: 404 },
  );
  const own = await f.application.assistants.openConversation(agent.id, {
    userId: user.id,
  });
  assert.equal(own.userId, user.id);
});

test("a user's queued message goes out as her turn", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { anna, agent } = await sharedAgentOfTwo(f);
  const assistants = f.application.assistants;
  const conversation = await assistants.openConversation(agent.id, {
    userId: anna.user.id,
  });
  assistants.queue(conversation.id, { text: "Later" });
  for (let i = 0; i < 50 && !gateway.sent.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const [request] = assistants.ledger.requests(conversation.id);
  assert.deepEqual(assistants.teams.store.context(request.id), {
    kind: "user",
    userId: anna.user.id,
    teamAllowed: false,
  });
});

test("the owner's chat on a shared agent takes no turns once it is a user's own", async (t) => {
  const { f } = await chatFixture(t);
  const { anna, agent } = await sharedAgentOfTwo(f);
  const opened = await f.request(`/api/assistants/${agent.id}/conversations`, {
    method: "POST",
  });
  const owner = await opened.json();
  const assistants = f.application.assistants;
  const moved = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "own", members: [{ userId: anna.user.id, level: "chat" }] },
      revision: assistants.store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(moved.status, 200, await moved.clone().text());
  const sent = await f.request(`/api/assistant-conversations/${owner.id}/messages`, {
    method: "POST",
    body: { clientRequestId: "after-own", text: "What do you know about Anna?" },
  });
  assert.equal(sent.status, 404);
  await assert.rejects(
    assistants.send(
      owner.id,
      { clientRequestId: "direct", text: "Hi" },
      { kind: "owner" },
    ),
    { status: 404 },
  );
  const read = await f.request(`/api/assistant-conversations/${owner.id}/messages`);
  assert.equal(read.status, 200);
});
