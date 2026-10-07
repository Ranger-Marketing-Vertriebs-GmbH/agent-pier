import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildChatRequest } from "../../../server/features/protocol-adapter/upstream-chat.js";
import { encodeCarrier } from "../../../server/features/protocol-adapter/carrier.js";
import {
  createIdMap,
  createNameMap,
} from "../../../server/features/protocol-adapter/names.js";
import { loadFixture } from "../../helpers/protocol-adapter.js";
import { assertChatRequest } from "../../helpers/protocol-adapter-shapes.js";

const ALL_CAPABILITIES = {
  promptCacheKey: true,
  streamUsage: true,
  reasoningEffort: true,
  parallelToolCalls: true,
  reasoningReplay: true,
};

function context(overrides = {}) {
  return {
    names: createNameMap({ pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 64 }),
    ids: createIdMap(/^[a-zA-Z0-9_-]+$/),
    capabilities: {},
    model: "upstream-model",
    sessionKey: "session-1",
    thinkTagExtraction: false,
    ...overrides,
  };
}

const snapshot = (name) => loadFixture(`ir/${name}.json`).ir;
const build = (ir, overrides) => buildChatRequest(ir, context(overrides));
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

const SNAPSHOTS = [
  "claude-code/mcp-tool-result",
  "claude-code/image",
  "claude-code/tool-result",
  "codex/mcp-output",
  "codex/apply-patch-output",
  "codex/function-call-output",
  "codex/reasoning-replay",
  "codex/image",
];

describe("client IR snapshots", () => {
  for (const name of SNAPSHOTS) {
    test(`${name} builds a valid Chat request`, () => {
      for (const capabilities of [{}, ALL_CAPABILITIES]) {
        const result = build(snapshot(name), { capabilities });
        assert.equal(result.path, "/chat/completions");
        assert.ok(Array.isArray(result.dropped));
        assertChatRequest(result.body);
        assert.equal(result.body.model, "upstream-model");
      }
    });
  }

  test("Claude Code MCP round trip: long name mapped, call answered, hints not sent", () => {
    const { body, dropped } = build(snapshot("claude-code/mcp-tool-result"), {
      capabilities: ALL_CAPABILITIES,
    });
    const assistant = body.messages.find((message) => message.tool_calls);
    const [call] = assistant.tool_calls;
    assert.ok(call.function.name.length <= 64);
    assert.notEqual(
      call.function.name,
      "mcp__fixture__lookup_project_documentation_with_a_deliberately_long_tool_name",
    );
    const result = body.messages[body.messages.indexOf(assistant) + 1];
    assert.deepEqual(result, {
      role: "tool",
      tool_call_id: call.id,
      content: "Documentation for adapters.",
    });
    assert.deepEqual(
      body.messages.map((message) => message.role),
      ["system", "user", "assistant", "tool", "user"],
    );
    const trailing = body.messages.at(-1).content.map((part) => part.text);
    assert.match(trailing[0], /^<system>\n# Environment/);
    assert.match(trailing[1], /^<system>\n<total_tokens>/);
    assert.equal(body.max_tokens, 32000);
    assert.equal(body.reasoning_effort, "high");
    assert.equal(body.prompt_cache_key, "session-1");
    assert.equal(body.parallel_tool_calls, undefined, "IR parallelToolCalls is null");
    const serialized = JSON.stringify(body);
    for (const leak of [
      "user_id",
      "anthropic-beta",
      "interleaved-thinking",
      "clear_thinking",
      "device_id",
    ]) {
      assert.ok(!serialized.includes(leak), leak);
    }
    assert.ok(dropped.includes("hints.metadata"));
  });

  test("Codex MCP output: namespaced name mapped, hosted tool dropped, two-part output joined", () => {
    const { body, dropped } = build(snapshot("codex/mcp-output"), {
      capabilities: ALL_CAPABILITIES,
    });
    const names = body.tools.map((tool) => tool.function.name);
    assert.ok(!names.includes("web_search"));
    assert.ok(dropped.includes("tools.web_search"));
    assert.ok(names.includes("multi_agent_v1__spawn_agent"));
    const [call] = body.messages.find((message) => message.tool_calls).tool_calls;
    assert.ok(call.function.name.startsWith("mcp__fixture__lookup"));
    assert.ok(call.function.name.length <= 64);
    const tool = body.messages.find((message) => message.role === "tool");
    assert.equal(
      tool.content,
      "Wall time: 0.0008 seconds\nOutput:\nMCP tool call requires approval, but approval policy is never",
    );
    assert.equal(body.parallel_tool_calls, true);
    assert.equal(body.prompt_cache_key, "01a115ae-3b84-7af1-9171-1c717c4ea4ae");
    assert.equal(body.max_tokens, undefined);
    const serialized = JSON.stringify(body);
    for (const leak of [
      "x-codex",
      "thread_id",
      "encrypted_content",
      "external_web_access",
    ]) {
      assert.ok(!serialized.includes(leak), leak);
    }
    assert.equal(body.store, undefined);
  });

  test("Codex apply_patch: custom tool becomes a function with an input string", () => {
    const { body } = build(snapshot("codex/apply-patch-output"));
    const tool = body.tools.find((entry) => entry.function.name === "apply_patch");
    assert.deepEqual(tool.function.parameters, {
      properties: { input: { type: "string" } },
      required: ["input"],
      type: "object",
    });
    assert.match(tool.function.description, /lark grammar/);
    assert.match(tool.function.description, /begin_patch: "\*\*\* Begin Patch" LF/);
    const [call] = body.messages.find((message) => message.tool_calls).tool_calls;
    assert.deepEqual(JSON.parse(call.function.arguments), {
      input: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n",
    });
  });

  test("Codex reasoning replay: summary is replayed only with reasoningReplay", () => {
    const ir = snapshot("codex/reasoning-replay");
    const assistantOf = (body) =>
      body.messages.find((message) => message.role === "assistant");
    const replayed = build(ir, { capabilities: { reasoningReplay: true } }).body;
    assert.equal(assistantOf(replayed).reasoning_content, "Plan the answer.");
    assert.equal(assistantOf(replayed).content, null);
    const plain = build(ir).body;
    assert.equal(assistantOf(plain).reasoning_content, undefined);
    assert.equal(plain.reasoning_effort, undefined);
    assert.equal(
      build(ir, { capabilities: ALL_CAPABILITIES }).body.reasoning_effort,
      "high",
    );
  });

  test("images become image_url parts with data URLs", () => {
    const { body } = build(snapshot("codex/image"));
    const user = body.messages.find((message) => Array.isArray(message.content));
    const image = user.content.find((part) => part.type === "image_url");
    assert.deepEqual(image, {
      type: "image_url",
      image_url: {
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        detail: "high",
      },
    });
    assert.equal(user.content[0].type, "text");
  });

  test("the body is deterministic and tool schema keys are sorted", () => {
    const first = JSON.stringify(build(snapshot("codex/mcp-output")).body);
    const second = JSON.stringify(build(snapshot("codex/mcp-output")).body);
    assert.equal(first, second);
    const ir = request({
      tools: [
        {
          name: "f",
          kind: "function",
          schema: {
            type: "object",
            properties: { b: {}, a: { type: "string", description: "x" } },
          },
        },
      ],
    });
    const { parameters } = build(ir).body.tools[0].function;
    assert.deepEqual(Object.keys(parameters), ["properties", "type"]);
    assert.deepEqual(Object.keys(parameters.properties), ["a", "b"]);
    assert.deepEqual(Object.keys(parameters.properties.a), ["description", "type"]);
  });
});

describe("messages", () => {
  test("system parts form one leading system message; system images are dropped", () => {
    const { body, dropped } = build(
      request({
        system: [
          text("one"),
          { type: "image", mediaType: "image/png", data: "AA" },
          text("two"),
        ],
      }),
    );
    assert.deepEqual(body.messages[0], { role: "system", content: "one\n\ntwo" });
    assert.ok(dropped.includes("system.image"));
  });

  test("tool results: [error] prefix, one message each, images follow in a user message", () => {
    const image = { type: "image", mediaType: "image/png", data: "QUJD" };
    const ir = request({
      tools: [{ name: "shot", kind: "function", schema: { type: "object" } }],
      messages: [
        { role: "user", parts: [text("go")] },
        {
          role: "assistant",
          parts: [
            text("Taking two."),
            { type: "toolCall", id: "a", name: "shot", kind: "function", input: "{}" },
            { type: "toolCall", id: "b", name: "shot", kind: "function", input: "" },
          ],
        },
        {
          role: "user",
          parts: [
            { type: "toolResult", callId: "a", parts: [text("failed")], isError: true },
            { type: "toolResult", callId: "b", parts: [image], isError: false },
            text("next"),
          ],
        },
      ],
    });
    const { body } = build(ir);
    assertChatRequest(body);
    assert.deepEqual(body.messages.slice(1), [
      {
        role: "assistant",
        content: "Taking two.",
        tool_calls: [
          { id: "a", type: "function", function: { name: "shot", arguments: "{}" } },
          { id: "b", type: "function", function: { name: "shot", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "[error] failed" },
      {
        role: "tool",
        tool_call_id: "b",
        content: "[image attached in the next message]",
      },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
          { type: "text", text: "next" },
        ],
      },
    ]);
  });

  test("ids are mapped through ctx.ids", () => {
    const ids = createIdMap(/^[a-z]+$/);
    const ir = request({
      tools: [{ name: "f", kind: "function", schema: {} }],
      messages: [
        {
          role: "assistant",
          parts: [
            { type: "toolCall", id: "call 1", name: "f", kind: "function", input: "{}" },
          ],
        },
        {
          role: "user",
          parts: [
            { type: "toolResult", callId: "call 1", parts: [text("ok")], isError: false },
          ],
        },
      ],
    });
    const { body } = buildChatRequest(ir, context({ ids }));
    const mapped = body.messages[0].tool_calls[0].id;
    assert.match(mapped, /^id_[0-9a-f]{8}$/);
    assert.equal(body.messages[1].tool_call_id, mapped);
    assert.equal(ids.fromUpstream(mapped), "call 1");
  });

  test("reasoning text, chat carriers and foreign carriers", () => {
    const reasoning = (part) =>
      request({
        messages: [
          { role: "user", parts: [text("q")] },
          { role: "assistant", parts: [{ type: "reasoning", ...part }, text("a")] },
        ],
      });
    const replay = (part) =>
      build(reasoning(part), { capabilities: { reasoningReplay: true } }).body
        .messages[1];
    assert.equal(replay({ text: "plain" }).reasoning_content, "plain");
    assert.equal(
      replay({ text: "", carrier: encodeCarrier("chat", "hidden thought") })
        .reasoning_content,
      "hidden thought",
    );
    assert.equal(
      replay({ carrier: encodeCarrier("messages", "signature") }).reasoning_content,
      undefined,
    );
    assert.deepEqual(replay({ redacted: true, carrier: "opaque" }), {
      role: "assistant",
      content: "a",
    });
  });

  test("assistant messages with only dropped content are omitted; users then merge", () => {
    const ir = request({
      messages: [
        { role: "user", parts: [text("q")] },
        { role: "assistant", parts: [{ type: "reasoning", text: "hmm" }] },
        { role: "user", parts: [text("again")] },
      ],
    });
    assert.deepEqual(build(ir).body.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "q" },
          { type: "text", text: "again" },
        ],
      },
    ]);
  });
});

describe("parameters and capabilities", () => {
  test("capabilities gate optional parameters", () => {
    const ir = request({
      tools: [{ name: "f", kind: "function", schema: {} }],
      parallelToolCalls: false,
      thinking: { mode: "enabled", budgetTokens: 16000 },
      cache: { key: "client-key" },
    });
    const none = build(ir, { capabilities: { streamUsage: false } }).body;
    for (const key of [
      "parallel_tool_calls",
      "reasoning_effort",
      "prompt_cache_key",
      "stream_options",
    ]) {
      assert.equal(none[key], undefined, key);
    }
    const all = build(ir, { capabilities: ALL_CAPABILITIES }).body;
    assert.equal(all.parallel_tool_calls, false);
    assert.equal(all.reasoning_effort, "high");
    assert.equal(all.prompt_cache_key, "client-key");
    assert.deepEqual(all.stream_options, { include_usage: true });
  });

  test("streamUsage defaults to on; non-streaming requests carry no stream_options", () => {
    assert.deepEqual(build(request()).body.stream_options, { include_usage: true });
    const body = build(request({ stream: false })).body;
    assert.equal(body.stream, false);
    assert.equal(body.stream_options, undefined);
  });

  test("reasoning_effort follows the thinking mode", () => {
    const effort = (thinking) =>
      build(request({ thinking }), { capabilities: { reasoningEffort: true } }).body
        .reasoning_effort;
    assert.equal(effort({ mode: "adaptive", effort: "minimal" }), "minimal");
    assert.equal(effort({ mode: "enabled", effort: "ultra" }), "max");
    assert.equal(effort({ mode: "enabled" }), "medium");
    assert.equal(effort({ mode: "disabled", effort: "high" }), undefined);
    assert.equal(effort({ mode: "between_tools", effort: "high" }), undefined);
    assert.equal(effort(null), undefined);
  });

  test("sampling, stop sequences, max_tokens and response_format", () => {
    const body = build(
      request({
        sampling: { maxOutputTokens: 512, temperature: 0.2, topP: 0.9, stop: ["END"] },
        output: {
          format: "json_schema",
          name: "answer",
          schema: { type: "object" },
          strict: true,
        },
      }),
    ).body;
    assert.equal(body.max_tokens, 512);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.stop, ["END"]);
    assert.deepEqual(body.response_format, {
      type: "json_schema",
      json_schema: { name: "answer", schema: { type: "object" }, strict: true },
    });
    const plain = build(request()).body;
    for (const key of ["max_tokens", "temperature", "top_p", "stop", "response_format"]) {
      assert.equal(plain[key], undefined, key);
    }
  });

  test("tool_choice maps named tools; no tools means no tool fields", () => {
    const ir = request({
      tools: [{ name: "f", namespace: "ns", kind: "function", schema: {} }],
      toolChoice: { name: "f", namespace: "ns" },
    });
    assert.deepEqual(build(ir).body.tool_choice, {
      type: "function",
      function: { name: "ns__f" },
    });
    assert.equal(build(request({ toolChoice: "required" })).body.tool_choice, undefined);
    const required = build({ ...ir, toolChoice: "required" }).body;
    assert.equal(required.tool_choice, "required");
  });

  test("a model object provides the upstream model id", () => {
    assert.equal(
      build(request(), { model: { id: "served-id" } }).body.model,
      "served-id",
    );
    assert.equal(build(request(), { model: undefined }).body.model, "client-model");
  });
});
