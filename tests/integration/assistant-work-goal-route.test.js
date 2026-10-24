import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { signedInUser } from "../helpers/users.js";
import { notFoundBody } from "../../server/http/responses.js";

// The owner's Stop of a work goal (AGENTPIER-208): his own chats only.

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

const openGoal = (f, conversationId) =>
  f.application.assistants.teams.goals.store.insert({
    parentAssistantId:
      f.application.assistants.store.getConversation(conversationId).assistantId,
    conversationId,
    title: "Episode",
    done: "Review cut",
    setRequestId: "r",
    anchorRequestId: "r",
    createdAt: 1,
  });

const stop = (request, id) =>
  request(`/api/assistant-conversations/${id}/goal/stop`, { method: "POST", body: {} });

test("the owner stops a goal through the route; a user's chat is refused", async (t) => {
  const { f } = await chatFixture(t);
  const goals = f.application.assistants.teams.goals;
  const agent = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: { name: "Helper", instructions: "", model: fixtureModel(f) },
    }),
    201,
  );
  const main = (
    await json(
      await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" }),
      200,
    )
  ).id;
  const goal = openGoal(f, main);
  assert.deepEqual(await json(await stop(f.request, main), 200), { goal: null });
  const stopped = goals.store.list(main).find((g) => g.id === goal.id);
  assert.equal(stopped.state, "stopped");
  // A second Stop finds nothing open.
  assert.deepEqual(await json(await stop(f.request, main), 200), { goal: null });

  const { user, cookie } = await signedInUser(f, "Anna");
  const hers = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "chat" }],
  });
  const annaMain = (
    await json(
      await as(f, cookie)(`/api/me/agents/${hers.id}/conversation`, { method: "POST" }),
      200,
    )
  ).id;
  const annaGoal = openGoal(f, annaMain);
  const refused = await stop(f.request, annaMain);
  assert.equal(refused.status, 404);
  assert.deepEqual(await refused.json(), notFoundBody());
  assert.equal(goals.store.open(annaMain)?.id, annaGoal.id);
});
