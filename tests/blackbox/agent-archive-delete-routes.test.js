import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { serverMessages } from "../../server/lib/i18n/de.js";

const json = (response) => response.json();

test("the owner archives, restores and deletes a user's agent; users cannot", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "extended" }],
  });
  const anna = as(f, cookie);
  // A restricted user reaches none of the routes, as if they did not exist.
  for (const [method, path, body] of [
    ["POST", `/api/assistants/${agent.id}/archive`, { revision: agent.revision }],
    ["POST", `/api/assistants/${agent.id}/restore`, { revision: agent.revision }],
    ["GET", `/api/assistants/${agent.id}/deletion`],
    ["DELETE", `/api/assistants/${agent.id}`, { name: agent.name }],
  ])
    assert.equal((await anna(path, { method, body })).status, 404, `${method} ${path}`);
  assert.equal(
    (
      await f.request(`/api/assistants/${agent.id}`, {
        method: "DELETE",
        body: { name: agent.name },
      })
    ).status,
    409,
  );
  let response = await f.request(`/api/assistants/${agent.id}/archive`, {
    method: "POST",
    body: { revision: agent.revision },
  });
  assert.equal(response.status, 200);
  const archived = await json(response);
  assert.ok(archived.archivedAt);
  // Her agent leaves her list while archived.
  const mine = await json(await anna("/api/me/agents"));
  assert.equal(JSON.stringify(mine).includes(agent.id), false);
  response = await f.request(`/api/assistants/${agent.id}/restore`, {
    method: "POST",
    body: { revision: archived.revision },
  });
  assert.equal(response.status, 200);
  const restored = await json(response);
  assert.equal(restored.archivedAt, null);
  const again = await json(
    await f.request(`/api/assistants/${agent.id}/archive`, {
      method: "POST",
      body: { revision: restored.revision },
    }),
  );
  const preview = await json(await f.request(`/api/assistants/${agent.id}/deletion`));
  assert.equal(preview.name, agent.name);
  assert.equal(typeof preview.counts.chats, "number");
  response = await f.request(`/api/assistants/${agent.id}`, {
    method: "DELETE",
    body: { name: "family" },
  });
  assert.equal(response.status, 400);
  assert.equal((await json(response)).error, serverMessages.assistants.agentDeleteName);
  response = await f.request(`/api/assistants/${agent.id}`, {
    method: "DELETE",
    body: { name: again.name },
  });
  assert.equal(response.status, 204);
  const list = await json(await f.request("/api/assistants"));
  assert.equal(
    list.assistants.some((a) => a.id === agent.id),
    false,
  );
  const events = f.application.audit
    .list({ resourceId: agent.id })
    .events.filter((e) => e.action !== "assistant.created");
  assert.deepEqual(events.map((e) => e.action).sort(), [
    "assistant.archived",
    "assistant.archived",
    "assistant.deleted",
    "assistant.restored",
  ]);
  assert.equal(JSON.stringify(events).includes(agent.name), false);
});
