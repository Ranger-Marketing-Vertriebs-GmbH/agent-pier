import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildMessagesRequest } from "../../../server/features/protocol-adapter/upstream-messages.js";
import { encodeCarrier } from "../../../server/features/protocol-adapter/carrier.js";
import {
  createIdMap,
  createNameMap,
} from "../../../server/features/protocol-adapter/names.js";
import { loadFixture } from "../../helpers/protocol-adapter.js";
import {
  assertMessagesRequest,
  countBreakpoints,
} from "../../helpers/protocol-adapter-shapes.js";

const TOOL_ID = /^[a-zA-Z0-9_-]+$/;
const SIGNATURE = "EqQBCkYIBxgCKkBfixtureSignature==";

function context(overrides = {}) {
  return {
    names: createNameMap({ pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 128 }),
    ids: createIdMap(TOOL_ID),
    capabilities: {},
    model: "claude-upstream",
    sessionKey: "session-1",
    ...overrides,
  };
}

const snapshot = (name) => loadFixture(`ir/codex/${name}.json`).ir;
const build = (ir, overrides) => buildMessagesRequest(ir, context(overrides));
const text = (value) => ({ type: "text", text: value });
const call = (id, extra = {}) => ({
  type: "toolCall",
  id,
  name: "exec_command",
  kind: "function",
  input: '{"cmd":"ls"}',
  ...extra,
});
const result = (callId, value = "ok") => ({
  type: "toolResult",
  callId,
  parts: [text(value)],
  isError: false,
});

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

describe("buildMessagesRequest with Codex snapshots", () => {
  for (const name of [
    "text",
    "function-call",
    "function-call-output",
    "apply-patch",
    "apply-patch-output",
    "mcp",
    "mcp-output",
    "reasoning",
    "reasoning-replay",
    "image",
    "web-search-disabled",
  ]) {
    test(`${name} builds a valid Messages request`, () => {
      const built = build(snapshot(name));
      assertMessagesRequest(built);
      assert.equal(built.body.model, "claude-upstream");
      assert.equal(built.body.max_tokens, 32000);
      assert.equal(built.body.stream, true);
      assert.ok(built.dropped.includes("cache.key"));
      assert.ok(built.dropped.some((entry) => entry.startsWith("hints.")));
      assert.ok(!JSON.stringify(built.body).includes("x-codex"));
    });
  }

  test("system blocks and auto cache breakpoints", () => {
    const built = build(snapshot("function-call-output"));
    const { system, messages } = built.body;
    assert.ok(system.length >= 2);
    assert.deepEqual(system.at(-1).cache_control, { type: "ephemeral" });
    assert.deepEqual(messages.at(-1).content.at(-1).cache_control, {
      type: "ephemeral",
    });
    assert.equal(countBreakpoints(built.body), 2);
    assert.ok(built.adjustments.includes("cache.autoBreakpoints"));
    const off = build(snapshot("function-call-output"), {
      capabilities: { promptCache: false },
    });
    assert.equal(countBreakpoints(off.body), 0);
  });

  test("hosted tools are dropped and namespaced MCP tools are flattened", () => {
    const built = build(snapshot("mcp-output"));
    const names = built.body.tools.map((tool) => tool.name);
    assert.ok(!names.includes("web_search"));
    assert.ok(built.dropped.includes("tools.web_search"));
    const mcp =
      "mcp__fixture__lookup_project_documentation_with_a_deliberately_long_tool_name";
    assert.ok(names.includes(mcp));
    assert.ok(names.includes("multi_agent_v1__spawn_agent"));
    const use = built.body.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_use");
    assert.equal(use.name, mcp);
    assert.deepEqual(use.input, { topic: "adapters" });
  });

  test("apply_patch becomes a function tool and history calls wrap the input", () => {
    const built = build(snapshot("apply-patch-output"));
    const tool = built.body.tools.find((entry) => entry.name === "apply_patch");
    assert.deepEqual(tool.input_schema, {
      properties: { input: { type: "string" } },
      required: ["input"],
      type: "object",
    });
    assert.match(tool.description, /grammar/);
    const use = built.body.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_use");
    assert.deepEqual(use.input, {
      input: "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n",
    });
  });

  test("image becomes a base64 image block", () => {
    const built = build(snapshot("image"));
    const image = built.body.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "image");
    assert.deepEqual(image.source.type, "base64");
    assert.equal(image.source.media_type, "image/png");
    assert.ok(image.source.data.startsWith("iVBOR"));
  });

  test("Codex effort-only thinking becomes adaptive with output_config.effort", () => {
    const built = build(snapshot("reasoning"));
    assert.equal(built.body.thinking.type, "adaptive");
    assert.equal(built.body.thinking.display, "summarized");
    assert.deepEqual(built.body.output_config, { effort: "high" });
    const manual = build(snapshot("reasoning"), {
      capabilities: { thinkingBudget: true },
    });
    assert.deepEqual(manual.body.thinking, { type: "enabled", budget_tokens: 16384 });
    assert.equal(manual.body.output_config, undefined);
  });

  test("non-messages reasoning carriers are not replayed", () => {
    const built = build(snapshot("reasoning-replay"));
    const types = built.body.messages.flatMap((message) =>
      message.content.map((block) => block.type),
    );
    assert.ok(!types.includes("thinking"));
    assert.ok(built.dropped.includes("assistant.reasoning"));
  });
});

describe("buildMessagesRequest rules", () => {
  test("messages-origin thinking and redacted thinking are replayed in order", () => {
    const ir = request({
      messages: [
        { role: "user", parts: [text("go")] },
        {
          role: "assistant",
          parts: [
            {
              type: "reasoning",
              summary: "Edited by the client.",
              carrier: encodeCarrier(
                "messages",
                JSON.stringify({ s: SIGNATURE, t: "Exact plan." }),
              ),
            },
            call("call_a"),
            {
              type: "reasoning",
              carrier: encodeCarrier("messages", JSON.stringify({ r: "opaque" })),
            },
            call("call_b"),
            {
              type: "reasoning",
              text: "Ignored.",
              carrier: encodeCarrier("messages", "sig"),
            },
            { type: "reasoning", text: "x", carrier: encodeCarrier("chat", "x") },
          ],
        },
        { role: "user", parts: [result("call_a"), result("call_b")] },
      ],
    });
    const built = build(ir);
    assertMessagesRequest(built);
    assert.deepEqual(built.body.messages[1].content, [
      { type: "thinking", thinking: "Exact plan.", signature: SIGNATURE },
      { type: "tool_use", id: "call_a", name: "exec_command", input: { cmd: "ls" } },
      { type: "redacted_thinking", data: "opaque" },
      { type: "tool_use", id: "call_b", name: "exec_command", input: { cmd: "ls" } },
      { type: "thinking", thinking: "", signature: "sig" }, // legacy plain signature
    ]);
    assert.ok(built.dropped.includes("assistant.reasoning"));
  });

  test("alternation: same-role neighbors merge, tool results lead the user turn", () => {
    const ir = request({
      system: [text("lead")],
      messages: [
        { role: "system", parts: [text("early")] },
        { role: "user", parts: [text("a")] },
        { role: "user", parts: [text("b")] },
        { role: "assistant", parts: [text("thinking about it")] },
        { role: "assistant", parts: [call("call.1")] },
        { role: "system", parts: [text("mid")] },
        { role: "user", parts: [text("extra"), result("call.1", "done")] },
      ],
    });
    const built = build(ir, { capabilities: { promptCache: false } });
    assertMessagesRequest(built);
    const { system, messages } = built.body;
    assert.deepEqual(system, [
      { type: "text", text: "lead" },
      { type: "text", text: "early" },
    ]);
    assert.equal(messages.length, 3);
    assert.deepEqual(messages[0].content, [text("a"), text("b")]);
    assert.deepEqual(
      messages[1].content.map((block) => block.type),
      ["text", "tool_use"],
    );
    const id = messages[1].content[1].id;
    assert.match(id, TOOL_ID);
    assert.deepEqual(messages[2].content, [
      { type: "tool_result", tool_use_id: id, content: [text("done")] },
      text("<system>\nmid\n</system>"),
      text("extra"),
    ]);
  });

  test("trailing system message becomes a user turn", () => {
    const ir = request({
      messages: [
        { role: "user", parts: [text("a")] },
        { role: "assistant", parts: [text("b")] },
        { role: "system", parts: [text("note")] },
      ],
    });
    const { messages } = build(ir).body;
    assert.equal(messages.at(-1).role, "user");
    assert.equal(messages.at(-1).content[0].text, "<system>\nnote\n</system>");
  });

  test("orphan results become text, missing results are synthesized", () => {
    const ir = request({
      messages: [
        { role: "user", parts: [result("call_gone"), text("hi")] },
        { role: "assistant", parts: [call("call_a"), call("call_b")] },
        { role: "user", parts: [result("call_a")] },
      ],
    });
    const built = build(ir);
    assertMessagesRequest(built);
    assert.equal(built.body.messages[0].content[0].type, "text");
    assert.match(built.body.messages[0].content[0].text, /ok/);
    assert.ok(built.dropped.includes("user.toolResult.orphan"));
    assert.ok(built.dropped.includes("assistant.toolCall.missingResult"));
  });

  test("tool result errors, images and url images", () => {
    const ir = request({
      messages: [
        {
          role: "user",
          parts: [
            { type: "image", mediaType: "image/png", url: "https://example.test/a.png" },
          ],
        },
        { role: "assistant", parts: [call("call_a")] },
        {
          role: "user",
          parts: [
            {
              type: "toolResult",
              callId: "call_a",
              isError: true,
              parts: [
                text("failed"),
                { type: "image", mediaType: "image/png", data: "AAAA" },
              ],
            },
          ],
        },
      ],
    });
    const { messages } = build(ir).body;
    assert.deepEqual(messages[0].content[0], {
      type: "image",
      source: { type: "url", url: "https://example.test/a.png" },
    });
    const block = messages[2].content[0];
    assert.equal(block.is_error, true);
    assert.deepEqual(block.content[1], {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });

  test("tool choice, parallel calls, stop sequences and sampling", () => {
    const tools = [
      { name: "exec_command", kind: "function", schema: { type: "object" } },
    ];
    const base = {
      tools,
      sampling: { maxOutputTokens: 4096, temperature: 0.2, topP: 0.9, stop: ["END"] },
    };
    const forced = build(
      request({
        ...base,
        toolChoice: { name: "exec_command" },
        parallelToolCalls: false,
      }),
    );
    assert.deepEqual(forced.body.tool_choice, {
      type: "tool",
      name: "exec_command",
      disable_parallel_tool_use: true,
    });
    assert.equal(forced.body.max_tokens, 4096);
    assert.deepEqual(forced.body.stop_sequences, ["END"]);
    assert.ok(!("temperature" in forced.body) && !("top_p" in forced.body));
    assert.ok(forced.dropped.includes("temperatureDropped"));
    assert.deepEqual(
      build(request({ ...base, toolChoice: "required" })).body.tool_choice,
      {
        type: "any",
      },
    );
    assert.deepEqual(build(request({ ...base, toolChoice: "none" })).body.tool_choice, {
      type: "none",
    });
    const relaxed = build(
      request({
        ...base,
        toolChoice: "required",
        thinking: { mode: "adaptive", effort: "minimal" },
      }),
    );
    assert.deepEqual(relaxed.body.tool_choice, { type: "auto" });
    assert.deepEqual(relaxed.body.output_config, { effort: "low" });
    assert.ok(relaxed.dropped.includes("toolChoiceRelaxed"));
    assert.ok(relaxed.dropped.includes("effortMinimalToLow"));
  });

  test("effort none omits thinking; budgets are clamped below max_tokens", () => {
    const none = build(request({ thinking: { mode: "enabled", effort: "none" } }));
    assert.equal(none.body.thinking, undefined);
    const clamped = build(
      request({
        thinking: { mode: "enabled", budgetTokens: 9000 },
        sampling: { maxOutputTokens: 4096, temperature: null, topP: null, stop: [] },
      }),
    );
    assert.deepEqual(clamped.body.thinking, { type: "enabled", budget_tokens: 4095 });
  });

  test("explicit cache marks are kept up to four, oldest dropped first", () => {
    const marked = (value) => ({ type: "text", text: value, cache: "ephemeral" });
    const ir = request({
      system: [marked("s1"), marked("s2")],
      messages: [
        { role: "user", parts: [marked("u1")] },
        { role: "assistant", parts: [text("a")] },
        { role: "user", parts: [marked("u2"), marked("u3")] },
      ],
    });
    const built = build(ir);
    assert.equal(countBreakpoints(built.body), 4);
    assert.equal(built.body.system[0].cache_control, undefined);
    assert.deepEqual(built.body.messages[2].content[1].cache_control, {
      type: "ephemeral",
    });
    assert.ok(built.dropped.includes("cache.breakpoints"));
  });

  test("json_schema output maps to output_config.format", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    const built = build(
      request({ output: { format: "json_schema", name: "x", schema } }),
    );
    assert.deepEqual(built.body.output_config, {
      format: { type: "json_schema", schema },
    });
  });
});
