import test from "node:test";
import assert from "node:assert/strict";
import {
  memoryReviewInputLimit,
  memoryReviewMethod,
  registerMemoryReview,
} from "../../server/features/assistants/team-plugin/memory-review.js";

// The product plugin's memory review method with a scripted `api.runtime.llm.complete`.
function method(complete) {
  let handler;
  const calls = [];
  registerMemoryReview({
    registerGatewayMethod: (name, h, options) => {
      assert.equal(name, memoryReviewMethod);
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
  const call = (
    params = { agentId: "ap-1", instructions: "Review.", input: "=== MEMORY.md\n- a" },
  ) =>
    new Promise((resolve) =>
      handler({
        params,
        respond: (ok, payload, error) => resolve({ ok, payload, error }),
      }),
    );
  return { call, calls };
}

test("one isolated completion on the agent's model with only the memory text", async () => {
  const { call, calls } = method(async () => ({ text: "<think>hm</think>\n[]" }));
  assert.deepEqual(await call(), { ok: true, payload: { text: "[]" }, error: undefined });
  assert.equal(calls.length, 1);
  const [request] = calls;
  assert.equal(request.agentId, "ap-1");
  assert.equal(request.systemPrompt, "Review.");
  assert.deepEqual(request.messages, [{ role: "user", content: "=== MEMORY.md\n- a" }]);
  assert.equal(request.purpose, "memory-review");
  assert.equal(request.maxTokens, 4000);
  assert.equal(request.reasoning, "off");
  assert.deepEqual(request.execution, {
    mode: "isolated-agent-runtime",
    timeoutMs: 120000,
  });
  assert.equal(request.tools, undefined);
});

test("a model without the thinking levels is asked without one", async () => {
  const { call, calls } = method(async (request) => {
    if (request.reasoning)
      throw Object.assign(Error("level"), { code: "LLM_ISOLATED_INPUT_REJECTED" });
    return { text: "[]" };
  });
  assert.equal((await call()).payload.text, "[]");
  assert.deepEqual(
    calls.map((c) => c.reasoning),
    ["off", "minimal", undefined],
  );
});

test("an invalid request or a failure answers no content", async () => {
  const { call, calls } = method(async () => ({ text: "[]" }));
  const big = "x".repeat(memoryReviewInputLimit + 1);
  for (const params of [
    {},
    { agentId: "ap-1", instructions: "Review.", input: big },
    { agentId: "ap-1", instructions: "", input: "x" },
  ])
    assert.deepEqual((await call(params)).error, {
      code: "INVALID_REQUEST",
      message: "invalid memory review request",
    });
  assert.equal(calls.length, 0);
  const failing = method(async () => {
    throw Object.assign(Error("secret memory text"), { code: "LLM_COMPLETION_TIMEOUT" });
  });
  assert.deepEqual((await failing.call()).error, {
    code: "UNAVAILABLE",
    message: "LLM_COMPLETION_TIMEOUT",
  });
});
