import test from "node:test";
import assert from "node:assert/strict";
import {
  chatTitleMethod,
  registerChatTitle,
} from "../../server/features/assistants/team-plugin/chat-title.js";

// The product plugin's title method with a scripted `api.runtime.llm.complete`.
function method(complete) {
  let handler;
  const calls = [];
  registerChatTitle({
    registerGatewayMethod: (name, h, options) => {
      assert.equal(name, chatTitleMethod);
      assert.deepEqual(options, { scope: "operator.admin" });
      handler = h;
    },
    runtime: {
      llm: {
        complete: async (request) => {
          calls.push(request);
          return complete(request);
        },
      },
    },
  });
  const call = (params = { agentId: "ap-1", message: "Plan Lisbon", reply: "Gladly" }) =>
    new Promise((resolve) =>
      handler({
        params,
        respond: (ok, payload, error) => resolve({ ok, payload, error }),
      }),
    );
  return { call, calls };
}

test("reasoning in the text is dropped before the answer is cut", async () => {
  const thinking = `<think>${"x".repeat(5000)}</think>\n\nTrip to Lisbon`;
  const { call, calls } = method(async () => ({ text: thinking }));
  assert.deepEqual(await call(), {
    ok: true,
    payload: { title: "Trip to Lisbon" },
    error: undefined,
  });
  // One isolated prompt for the asking agent: no tools, thinking off.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agentId, "ap-1");
  assert.equal(calls[0].reasoning, "off");
  assert.equal(calls[0].execution.mode, "isolated-agent-runtime");
  assert.equal(calls[0].tools, undefined);
  // A long answer still stays bounded.
  const long = method(async () => ({ text: "y".repeat(1000) }));
  assert.equal((await long.call()).payload.title.length, 400);
});

test("a model without the thinking levels is asked without one", async () => {
  const { call, calls } = method(async (request) => {
    if (request.reasoning)
      throw Object.assign(Error("level"), { code: "LLM_ISOLATED_INPUT_REJECTED" });
    return { text: "Trip" };
  });
  assert.equal((await call()).payload.title, "Trip");
  assert.deepEqual(
    calls.map((c) => c.reasoning),
    ["off", "minimal", undefined],
  );
});

test("a failure answers OpenClaw's code and never its text", async () => {
  const timeout = method(async () => {
    throw Object.assign(Error("secret prompt text"), { code: "LLM_COMPLETION_TIMEOUT" });
  });
  assert.deepEqual((await timeout.call()).error, {
    code: "UNAVAILABLE",
    message: "LLM_COMPLETION_TIMEOUT",
  });
  const odd = method(async () => {
    throw Object.assign(Error("secret"), { code: "weird code: secret" });
  });
  assert.deepEqual((await odd.call()).error, {
    code: "UNAVAILABLE",
    message: "LLM_COMPLETION_FAILED",
  });
  const refused = method(async () => ({ text: "never" }));
  assert.equal((await refused.call({ agentId: "ap-1" })).error.code, "INVALID_REQUEST");
  assert.equal(refused.calls.length, 0);
});
