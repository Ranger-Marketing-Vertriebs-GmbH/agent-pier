import test from "node:test";
import assert from "node:assert/strict";
import { handOver } from "../../server/features/assistants/team-coding.js";
import { chatProblem } from "../../server/features/assistants/agent-chats.js";

// A workflow host whose send fails with `error`; patches land in `patches`.
function host(error) {
  const patches = [];
  return {
    patches,
    w: {
      now: () => 1000,
      a: {
        send: async () => {
          throw error;
        },
      },
      store: { patch: (id, value) => patches.push({ id, ...value }) },
    },
  };
}

const delivery = { conversationId: "c1", requestId: "r1", text: "Hi", context: {} };

test("a follow-up into an archived chat settles instead of retrying", async () => {
  const { w, patches } = host(chatProblem("CHAT_ARCHIVED"));
  assert.equal(await handOver(w, { id: "a1" }, "parentResult", delivery), true);
  assert.deepEqual(patches, [
    {
      id: "a1",
      parentResult: { skipped: "CHAT_ARCHIVED" },
      parentResultRetryAt: undefined,
    },
  ]);
});

test("a busy chat still retries a follow-up", async () => {
  const { w, patches } = host(Object.assign(new Error("busy"), { status: 409 }));
  assert.equal(await handOver(w, { id: "a1" }, "parentResult", delivery), false);
  assert.equal(patches[0].parentResultFailures, 1);
});
