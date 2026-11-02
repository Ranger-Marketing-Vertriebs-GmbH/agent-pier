import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

const preview = (request, id, connectionId, modelId) =>
  request(
    `/api/assistants/${id}/model-switch?` +
      new URLSearchParams({ connectionId, modelId }),
  );

test("the owner sees whether a model change switches the family", async (t) => {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: anna.user.id, level: "chat" }],
  });
  const { connectionId } = agent.model;
  const same = await preview(f.request, agent.id, connectionId, "openai/gpt-5");
  assert.equal(same.status, 200);
  assert.deepEqual(await same.json(), { familyChanged: false, freshChatsDefault: false });
  const other = await preview(f.request, agent.id, connectionId, "x-ai/grok-4.7");
  assert.deepEqual(await other.json(), { familyChanged: true, freshChatsDefault: true });
  const unknown = await preview(f.request, agent.id, "nope", "x-ai/grok-4.7");
  assert.equal(unknown.status, 400);
  const noModel = await f.request(
    `/api/assistants/${agent.id}/model-switch?connectionId=${connectionId}`,
  );
  assert.equal(noModel.status, 400);
  const denied = await preview(
    as(f, anna.cookie),
    agent.id,
    connectionId,
    "x-ai/grok-4.7",
  );
  assert.equal(denied.status, 404);
});
