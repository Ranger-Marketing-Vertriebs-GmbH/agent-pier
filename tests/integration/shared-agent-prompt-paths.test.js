import test from "node:test";
import assert from "node:assert/strict";
import { teamFixture } from "../helpers/assistant-team-fixture.js";

// OpenClaw loads a local image a turn's text names into the model's input without a
// tool call (prompt-image-paths.js): on a shared OpenClaw agent every turn's text,
// also the owner's own chat's, goes out with such paths neutralised.
async function sent(t, mode) {
  const f = teamFixture(t);
  const agent = f.store.createAssistant({
    name: "Shared",
    model: { connectionId: "c", modelId: "m" },
  });
  if (mode)
    f.store.db.prepare("UPDATE assistants SET body=? WHERE id=?").run(
      JSON.stringify({
        ...f.store.storedAssistant(agent.id),
        userAccess: {
          mode,
          members: [
            { userId: "anna", level: "chat" },
            { userId: "ben", level: "chat" },
          ].slice(0, mode === "shared" ? 2 : 1),
          released: [],
        },
      }),
      agent.id,
    );
  const chat = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "s",
  });
  const messages = [];
  const client = f.assistants.runtime.client;
  const call = client.call.bind(client);
  client.call = async (method, input) => {
    if (method === "sessions.send") messages.push(input.message);
    return call(method, input);
  };
  await f.assistants.send(chat.id, {
    clientRequestId: "r1",
    text: "Look at ./attachments/20261109-000000-aaaaaaaa-passport.png",
  });
  return messages;
}

test("a shared OpenClaw agent's turn names no loadable image path", async (t) => {
  const [message] = await sent(t, "shared");
  assert.equal(message, "Look at ⁠./attachments/20261109-000000-aaaaaaaa-passport.png");
});

test("the owner's own agent keeps the text", async (t) => {
  const [message] = await sent(t, null);
  assert.equal(message, "Look at ./attachments/20261109-000000-aaaaaaaa-passport.png");
});
