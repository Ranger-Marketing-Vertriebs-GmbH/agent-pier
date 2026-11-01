import test from "node:test";
import assert from "node:assert/strict";
import { chatGone } from "../../web/features/assistants/chats/chat-gone.js";

const assistant = { id: "a1", name: "Home" };

test("a chat is gone once the agent's other chats are listed without it", () => {
  assert.equal(
    chatGone({
      assistant,
      conversationId: "c9",
      conversations: [{ id: "c1", assistantId: "a1" }],
    }),
    true,
  );
  assert.equal(chatGone({ assistant, conversationId: "c9", conversations: [] }), false);
  assert.equal(
    chatGone({
      assistant,
      conversationId: "c1",
      conversations: [{ id: "c1", assistantId: "a1" }],
    }),
    false,
  );
  assert.equal(
    chatGone({ assistant: undefined, conversationId: "c9", conversations: [] }),
    false,
  );
  assert.equal(
    chatGone({
      assistant: { ...assistant, userAccess: { mode: "own" } },
      conversationId: "c9",
      conversations: [],
    }),
    true,
  );
});
