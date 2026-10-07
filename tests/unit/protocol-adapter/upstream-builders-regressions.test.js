import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildChatRequest } from "../../../server/features/protocol-adapter/upstream-chat.js";
import { buildMessagesRequest } from "../../../server/features/protocol-adapter/upstream-messages.js";
import { buildResponsesRequest } from "../../../server/features/protocol-adapter/upstream-responses.js";
import {
  createIdMap,
  createNameMap,
} from "../../../server/features/protocol-adapter/names.js";

function context(overrides = {}) {
  return {
    names: createNameMap({ pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 64 }),
    ids: createIdMap(/^[a-zA-Z0-9_-]+$/),
    capabilities: {},
    model: "upstream-model",
    sessionKey: "session-1",
    ...overrides,
  };
}

const text = (value) => ({ type: "text", text: value });

function request(overrides = {}) {
  return {
    model: "client-model",
    system: [],
    messages: [{ role: "user", parts: [text("hi")] }],
    tools: [],
    toolChoice: "auto",
    parallelToolCalls: null,
    sampling: { maxOutputTokens: null, temperature: null, topP: null, stop: [] },
    thinking: null,
    output: null,
    cache: { key: null },
    stream: true,
    ...overrides,
  };
}

describe("unknown effort is counted on every upstream", () => {
  const thinking = { mode: "enabled", effort: "turbo" };

  test("Messages", () => {
    const built = buildMessagesRequest(request({ thinking }), context());
    assert.equal(built.body.output_config.effort, "medium");
    assert.ok(built.adjustments.includes("effortUnknown"));
  });

  test("Responses", () => {
    const built = buildResponsesRequest(request({ thinking }), context());
    assert.equal(built.body.reasoning.effort, "medium");
    assert.ok(built.adjustments.includes("effortUnknown"));
  });

  test("Chat", () => {
    const ctx = context({ capabilities: { reasoningEffort: true } });
    const built = buildChatRequest(request({ thinking }), ctx);
    assert.equal(built.body.reasoning_effort, "medium");
    assert.ok(built.adjustments.includes("effortUnknown"));
  });

  test("known efforts are not counted", () => {
    const known = { mode: "enabled", effort: "high" };
    const ctx = context({ capabilities: { reasoningEffort: true } });
    for (const build of [buildMessagesRequest, buildResponsesRequest, buildChatRequest]) {
      const built = build(request({ thinking: known }), ctx);
      assert.ok(!built.adjustments.includes("effortUnknown"));
    }
  });
});

test("Messages keeps adaptive thinking with a small max_tokens", () => {
  const built = buildMessagesRequest(
    request({
      thinking: { mode: "adaptive", effort: "high" },
      sampling: { maxOutputTokens: 1000, stop: [] },
    }),
    context(),
  );
  assert.equal(built.body.max_tokens, 1000);
  assert.deepEqual(built.body.thinking, { type: "adaptive" });
  assert.equal(built.body.output_config.effort, "high");
});
