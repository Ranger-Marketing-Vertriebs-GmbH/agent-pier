import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildChatRequest,
  parseChatStream,
} from "../../../server/features/protocol-adapter/upstream-chat.js";
import {
  buildMessagesRequest,
  parseMessagesStream,
} from "../../../server/features/protocol-adapter/upstream-messages.js";
import {
  buildResponsesRequest,
  parseResponsesStream,
} from "../../../server/features/protocol-adapter/upstream-responses.js";
import { createTranslator } from "../../../server/features/protocol-adapter/translate.js";
import { collect, fromChunks } from "../../helpers/protocol-adapter.js";
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

describe("Responses forced tool choice", () => {
  const tools = [
    { name: "exec", kind: "function", schema: { type: "object" } },
    { name: "apply_patch", kind: "custom", grammar: { syntax: "lark", definition: "x" } },
    {
      name: "web_search",
      kind: "hosted",
      hostedType: "web_search",
      raw: { type: "web_search" },
    },
    {
      name: "claude_search",
      kind: "hosted",
      hostedType: "web_search",
      raw: { type: "web_search_20250305", name: "claude_search" },
    },
  ];
  const choose = (toolChoice) =>
    buildResponsesRequest(request({ tools, toolChoice }), context());

  test("a custom tool is forced as { type: custom, name }", () => {
    assert.deepEqual(choose({ name: "apply_patch" }).body.tool_choice, {
      type: "custom",
      name: "apply_patch",
    });
    assert.deepEqual(choose({ name: "exec" }).body.tool_choice, {
      type: "function",
      name: "exec",
    });
  });

  test("a forwarded hosted tool is forced by type; a dropped one becomes auto", () => {
    assert.deepEqual(choose({ name: "web_search" }).body.tool_choice, {
      type: "web_search",
    });
    const dropped = choose({ name: "claude_search" });
    assert.equal(dropped.body.tool_choice, "auto");
    assert.ok(dropped.adjustments.includes("toolChoice.hostedToolDropped"));
  });
});

describe("upstream parsers redact ctx.secrets from error messages", () => {
  const SECRET = "plain-upstream-password";
  const ctx = () => context({ secrets: [SECRET] });
  const message = `invalid key ${SECRET}`;
  async function* events(items) {
    for (const item of items) yield { data: JSON.stringify(item) };
  }
  const errorOf = (out) => out.find((event) => event.type === "error").error;

  test("Chat", async () => {
    const out = await collect(parseChatStream(events([{ error: { message } }]), ctx()));
    assert.doesNotMatch(errorOf(out).message, /plain-upstream-password/);
  });

  test("Responses", async () => {
    const failed = { type: "response.failed", response: { error: { message } } };
    const out = await collect(parseResponsesStream(events([failed]), ctx()));
    assert.doesNotMatch(errorOf(out).message, /plain-upstream-password/);
  });

  test("Messages", async () => {
    const error = { type: "error", error: { type: "api_error", message } };
    const out = await collect(parseMessagesStream(events([error]), ctx()));
    assert.doesNotMatch(errorOf(out).message, /plain-upstream-password/);
  });
});

test("the translator passes one per-request ctx to the builder and the parser", async () => {
  const translator = createTranslator({
    client: "messages",
    upstream: "chat",
    model: { modelId: "upstream-model", contextTokens: 8000, outputTokens: null },
  });
  const built = translator.buildUpstream(
    {
      model: "m",
      max_tokens: 100,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    },
    {},
    { requestId: "req_ctx" },
  );
  const chunks = [
    `data: ${JSON.stringify({
      id: "x",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ function: { name: "f", arguments: "{}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  const text = (await collect(built.exchange.translateStream(fromChunks(chunks)))).join(
    "",
  );
  // The parser sees the request id (fallback call id) and the built body's size.
  assert.match(text, /"id":"call_req_ctx_0"/);
  const input = Math.ceil(JSON.stringify(built.request.body).length / 4);
  assert.match(text, new RegExp(`"input_tokens":${input}`));
});
