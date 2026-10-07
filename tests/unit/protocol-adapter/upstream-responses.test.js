import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildResponsesRequest } from "../../../server/features/protocol-adapter/upstream-responses.js";
import { encodeCarrier } from "../../../server/features/protocol-adapter/carrier.js";
import {
  createIdMap,
  createNameMap,
} from "../../../server/features/protocol-adapter/names.js";
import { loadFixture } from "../../helpers/protocol-adapter.js";

const FUNCTION_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

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

const snapshot = (name) => loadFixture(`ir/claude-code/${name}.json`).ir;
const build = (ir, overrides) => buildResponsesRequest(ir, context(overrides));
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

const ALLOWED_TOP = new Set([
  "model",
  "instructions",
  "input",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "include",
  "max_output_tokens",
  "temperature",
  "top_p",
  "text",
  "prompt_cache_key",
  "store",
  "stream",
]);
const IR_KEYS = new Set([
  "parts",
  "kind",
  "namespace",
  "cache",
  "carrier",
  "isError",
  "callId",
  "id",
  "mediaType",
  "data",
]);
const CONTENT_TYPES = {
  user: ["input_text", "input_image"],
  developer: ["input_text"],
  assistant: ["output_text"],
};

function assertNoIrKeys(value, path) {
  if (Array.isArray(value))
    return value.forEach((item, i) => assertNoIrKeys(item, `${path}[${i}]`));
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (path.includes(".parameters")) continue; // tool schemas are client data
    assert.ok(!IR_KEYS.has(key), `${path}.${key} is an IR leftover`);
    assertNoIrKeys(child, `${path}.${key}`);
  }
}

function assertContent(item, where) {
  assert.ok(Array.isArray(item.content) && item.content.length > 0, where);
  for (const part of item.content) {
    assert.ok(CONTENT_TYPES[item.role].includes(part.type), `${where} ${part.type}`);
    if (part.type === "input_image") assert.match(part.image_url, /^(data:|https?:)/);
    else assert.equal(typeof part.text, "string");
  }
}

/** Minimal Responses request validator for the item shapes this adapter sends. */
function assertResponsesShape(body) {
  for (const key of Object.keys(body))
    assert.ok(ALLOWED_TOP.has(key), `unexpected ${key}`);
  assert.equal(typeof body.model, "string");
  assert.equal(body.store, false);
  assert.ok(Array.isArray(body.input) && body.input.length > 0);
  const toolNames = new Set();
  for (const tool of body.tools ?? []) {
    assert.ok(["function", "custom"].includes(tool.type));
    assert.match(tool.name, FUNCTION_NAME);
    if (tool.type === "function") assert.equal(typeof tool.strict, "boolean");
    assert.ok(!toolNames.has(tool.name), "tool names are unique");
    toolNames.add(tool.name);
  }
  const open = new Map();
  body.input.forEach((item, index) => {
    const where = `input[${index}]`;
    assert.equal(item.id, undefined, `${where} carries no item id`);
    if (item.type === "message") {
      assert.ok(["user", "developer", "assistant"].includes(item.role), where);
      assertContent(item, where);
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      assert.match(item.name, FUNCTION_NAME);
      assert.ok(toolNames.has(item.name), `${where} names a declared tool`);
      open.set(item.call_id, item.type);
    } else if (item.type.endsWith("_call_output")) {
      const call = open.get(item.call_id);
      assert.ok(call, `${where} answers an open call`);
      assert.equal(item.type, `${call}_output`);
      open.delete(item.call_id);
      assert.ok(typeof item.output === "string" || Array.isArray(item.output));
    } else if (item.type === "reasoning") {
      assert.ok(Array.isArray(item.summary));
      assert.equal(typeof item.encrypted_content, "string");
    } else assert.fail(`${where} unknown type ${item.type}`);
  });
  assert.equal(open.size, 0, "every call has an output");
  assertNoIrKeys(body.input, "input");
  assertNoIrKeys(body.tools ?? [], "tools");
}

describe("buildResponsesRequest on Claude Code snapshots", () => {
  for (const name of [
    "text",
    "tool-call",
    "tool-result",
    "mcp",
    "mcp-tool-result",
    "image",
  ]) {
    test(`${name} builds a valid Responses request`, () => {
      const ir = snapshot(name);
      const { path, body, dropped } = build(ir);
      assert.equal(path, "/responses");
      assertResponsesShape(body);
      assert.equal(body.model, "upstream-model");
      assert.equal(body.max_output_tokens, 32000);
      assert.equal(body.stream, true);
      assert.ok(dropped.includes("hints.anthropicBeta"));
      const serialized = JSON.stringify(body);
      for (const hint of [
        "device_id",
        "clear_thinking_20251015",
        "claude-code-20250219",
      ]) {
        assert.ok(!serialized.includes(hint), `${hint} is not forwarded`);
      }
      assert.equal(body.instructions, ir.system.map((part) => part.text).join("\n\n"));
    });
  }

  test("thinking adaptive/high with display omitted sends effort without summary", () => {
    const { body } = build(snapshot("text"));
    assert.deepEqual(body.reasoning, { effort: "high" });
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  });

  test("display updates requests summaries", () => {
    const { body } = build(snapshot("image"));
    assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  });

  test("tool result pairs a function_call with its function_call_output", () => {
    const { body } = build(snapshot("tool-result"));
    const call = body.input.find((item) => item.type === "function_call");
    const output = body.input.find((item) => item.type === "function_call_output");
    assert.equal(call.name, "Bash");
    assert.equal(call.arguments, '{"command":"ls","description":"List files"}');
    assert.equal(output.call_id, call.call_id);
    assert.equal(typeof output.output, "string");
  });

  test("mid-conversation system messages become developer items in place", () => {
    const ir = snapshot("tool-result");
    const { body } = build(ir);
    const roles = body.input.map((item) => item.role ?? item.type);
    assert.deepEqual(roles, [
      "user",
      "developer",
      "function_call",
      "function_call_output",
      "developer",
    ]);
    assert.equal(body.input[4].content[0].text, ir.messages.at(-1).parts[0].text);
  });

  test("long MCP names are mapped to ≤64 chars consistently", () => {
    const ctx = context();
    const ir = snapshot("mcp-tool-result");
    const { body } = buildResponsesRequest(ir, ctx);
    const long = ir.tools.find((tool) => tool.name.length > 64);
    assert.ok(long, "fixture has a long MCP name");
    const mapped = ctx.names.toUpstream(long.name);
    assert.match(mapped, FUNCTION_NAME);
    assert.ok(body.tools.some((tool) => tool.name === mapped));
    assert.equal(body.input.find((item) => item.type === "function_call").name, mapped);
    assert.deepEqual(ctx.names.fromUpstream(mapped), { name: long.name });
  });

  test("image parts become input_image data URLs", () => {
    const { body } = build(snapshot("image"));
    const image = body.input[0].content.find((part) => part.type === "input_image");
    assert.match(image.image_url, /^data:image\/png;base64,iVBOR/);
    assert.equal(image.detail, "auto");
  });
});

describe("buildResponsesRequest rules", () => {
  test("no hints, store false, no include without thinking", () => {
    const { body } = build(
      request({ hints: { safeguards: { x: 1 }, anthropicBeta: "b" } }),
    );
    assert.deepEqual(body, {
      model: "upstream-model",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      ],
      store: false,
      stream: true,
    });
  });

  test("leading system messages join the instructions", () => {
    const { body } = build(
      request({
        system: [text("a")],
        messages: [
          { role: "system", parts: [text("b")] },
          { role: "user", parts: [text("hi")] },
        ],
      }),
    );
    assert.equal(body.instructions, "a\n\nb");
    assert.equal(body.input.length, 1);
  });

  test("effort mapping is safe for OpenAI models", () => {
    const effort = (thinking) => build(request({ thinking })).body.reasoning;
    assert.deepEqual(effort({ mode: "adaptive", effort: "max" }), {
      effort: "high",
      summary: "auto",
    });
    assert.equal(effort({ mode: "adaptive", effort: "xhigh" }).effort, "high");
    assert.equal(effort({ mode: "adaptive", effort: "minimal" }).effort, "low");
    assert.equal(effort({ mode: "adaptive", effort: "low" }).effort, "low");
    assert.equal(effort({ mode: "enabled", budgetTokens: 8000 }).effort, "medium");
    assert.equal(effort({ mode: "enabled", budgetTokens: 30000 }).effort, "high");
    assert.equal(effort({ mode: "adaptive" }).effort, "medium");
    assert.equal(effort({ mode: "disabled" }), undefined);
    assert.equal(effort({ mode: "between_tools", effort: "high" }), undefined);
    assert.equal(effort({ mode: "adaptive", effort: "none" }), undefined);
    assert.deepEqual(effort({ mode: "adaptive", effort: "low", summary: "none" }), {
      effort: "low",
    });
  });

  test("effort clamps are counted in dropped", () => {
    const dropped = (effort) =>
      build(request({ thinking: { mode: "adaptive", effort } })).dropped;
    assert.ok(dropped("max").includes("reasoning.effort.clamped"));
    assert.ok(dropped("xhigh").includes("reasoning.effort.clamped"));
    assert.ok(dropped("minimal").includes("reasoning.effort.clamped"));
    assert.ok(!dropped("high").includes("reasoning.effort.clamped"));
    assert.ok(!dropped("low").includes("reasoning.effort.clamped"));
  });

  test("function tools always send an explicit strict flag", () => {
    const { body } = build(
      request({ tools: [{ name: "f", kind: "function", schema: { type: "object" } }] }),
    );
    assert.equal(body.tools[0].strict, false);
  });

  test("json schema output without a name gets a default name", () => {
    const { body } = build(
      request({
        output: { format: "json_schema", name: "", schema: { type: "object" } },
      }),
    );
    assert.equal(body.text.format.name, "output");
  });

  test("reasoning can be switched off by capability", () => {
    const { body } = build(request({ thinking: { mode: "adaptive", effort: "high" } }), {
      capabilities: { reasoningEffort: false },
    });
    assert.equal(body.reasoning, undefined);
    assert.equal(body.include, undefined);
  });

  test("capabilities gate prompt_cache_key and parallel_tool_calls", () => {
    const tools = [{ name: "f", kind: "function", schema: { type: "object" } }];
    const ir = request({ tools, parallelToolCalls: true });
    assert.equal(build(ir).body.prompt_cache_key, undefined);
    assert.equal(build(ir).body.parallel_tool_calls, undefined);
    const on = build(ir, {
      capabilities: { promptCacheKey: true, parallelToolCalls: true },
    }).body;
    assert.equal(on.prompt_cache_key, "session-1");
    assert.equal(on.parallel_tool_calls, true);
    const keyed = build(request({ cache: { key: "k" } }), {
      capabilities: { promptCacheKey: true },
    }).body;
    assert.equal(keyed.prompt_cache_key, "k");
  });

  test("sampling passes only present values; stop sequences are dropped", () => {
    const { body, dropped } = build(
      request({
        sampling: { maxOutputTokens: 100, temperature: 0.2, topP: 0.9, stop: ["x"] },
      }),
    );
    assert.equal(body.max_output_tokens, 100);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.stop, undefined);
    assert.ok(dropped.includes("sampling.stop"));
  });

  test("tool definitions, forced choice and json schema output", () => {
    const { body } = build(
      request({
        tools: [
          {
            name: "f",
            kind: "function",
            description: "d",
            schema: { type: "object", properties: { b: {}, a: {} } },
            strict: true,
          },
          {
            name: "apply_patch",
            kind: "custom",
            description: "p",
            grammar: { type: "grammar", syntax: "lark", definition: "start: x" },
          },
          { name: "web", kind: "hosted", hostedType: "web_search" },
        ],
        toolChoice: { name: "f" },
        output: {
          format: "json_schema",
          name: "o",
          schema: { type: "object" },
          strict: true,
        },
      }),
    );
    assert.deepEqual(body.tools[0], {
      type: "function",
      name: "f",
      description: "d",
      parameters: { properties: { a: {}, b: {} }, type: "object" },
      strict: true,
    });
    assert.deepEqual(body.tools[1], {
      type: "custom",
      name: "apply_patch",
      description: "p",
      format: { type: "grammar", syntax: "lark", definition: "start: x" },
    });
    assert.equal(body.tools.length, 2);
    assert.deepEqual(body.tool_choice, { type: "function", name: "f" });
    assert.deepEqual(body.text, {
      format: {
        type: "json_schema",
        name: "o",
        schema: { type: "object" },
        strict: true,
      },
    });
  });

  test("hosted tools with a raw definition are kept", () => {
    const raw = { type: "web_search", external_web_access: false };
    const { body, dropped } = build(
      request({
        tools: [{ name: "web_search", kind: "hosted", hostedType: "web_search", raw }],
      }),
    );
    assert.deepEqual(body.tools, [raw]);
    assert.deepEqual(dropped, []);
  });

  test("tool result images go into a content array; errors are prefixed", () => {
    const image = { type: "image", mediaType: "image/png", data: "AAAA" };
    const { body } = build(
      request({
        tools: [{ name: "shot", kind: "function", schema: { type: "object" } }],
        messages: [
          { role: "user", parts: [text("go")] },
          {
            role: "assistant",
            parts: [
              {
                type: "toolCall",
                id: "toolu_1",
                name: "shot",
                kind: "function",
                input: "",
              },
              {
                type: "toolCall",
                id: "toolu_2",
                name: "shot",
                kind: "function",
                input: "{}",
              },
            ],
          },
          {
            role: "user",
            parts: [
              {
                type: "toolResult",
                callId: "toolu_1",
                parts: [text("ok"), image],
                isError: false,
              },
              {
                type: "toolResult",
                callId: "toolu_2",
                parts: [text("boom")],
                isError: true,
              },
              text("next"),
            ],
          },
        ],
      }),
    );
    assertResponsesShape(body);
    const [, first, , out1, out2, user] = body.input;
    assert.equal(first.arguments, "{}");
    assert.deepEqual(out1.output, [
      { type: "input_text", text: "ok" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "auto" },
    ]);
    assert.equal(out2.output, "[error] boom");
    assert.deepEqual(user.content, [{ type: "input_text", text: "next" }]);
  });

  test("custom tool calls replay as custom_tool_call items", () => {
    const { body } = build(
      request({
        tools: [{ name: "apply_patch", kind: "custom" }],
        messages: [
          { role: "user", parts: [text("go")] },
          {
            role: "assistant",
            parts: [
              text("Patching."),
              {
                type: "toolCall",
                id: "c1",
                name: "apply_patch",
                kind: "custom",
                input: "*** x",
              },
            ],
          },
          {
            role: "user",
            parts: [
              { type: "toolResult", callId: "c1", parts: [text("done")], isError: false },
            ],
          },
        ],
      }),
    );
    assertResponsesShape(body);
    assert.deepEqual(body.input[1], {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Patching.", annotations: [] }],
    });
    assert.deepEqual(body.input[2], {
      type: "custom_tool_call",
      call_id: "c1",
      name: "apply_patch",
      input: "*** x",
    });
    assert.equal(body.input[3].type, "custom_tool_call_output");
  });

  test("responses-origin carriers replay as encrypted reasoning; others are dropped", () => {
    const carrier = encodeCarrier("responses", "gAAAAencrypted==");
    const { body, dropped } = build(
      request({
        thinking: { mode: "adaptive", effort: "high", display: "omitted" },
        messages: [
          { role: "user", parts: [text("hi")] },
          {
            role: "assistant",
            parts: [
              { type: "reasoning", text: "Planning", carrier },
              {
                type: "reasoning",
                text: "other",
                carrier: encodeCarrier("messages", "sig"),
              },
              { type: "reasoning", text: "plain" },
              text("Hello."),
            ],
          },
          { role: "user", parts: [text("again")] },
        ],
      }),
    );
    assertResponsesShape(body);
    assert.deepEqual(body.input[1], {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Planning" }],
      encrypted_content: "gAAAAencrypted==",
    });
    assert.equal(body.input[2].role, "assistant");
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.equal(body.input.filter((item) => item.type === "reasoning").length, 1);
    assert.ok(dropped.includes("assistant.reasoning"));
  });

  test("replayed reasoning requests encrypted content even without thinking", () => {
    const carrier = encodeCarrier("responses", "enc");
    const { body } = build(
      request({
        messages: [
          { role: "user", parts: [text("hi")] },
          {
            role: "assistant",
            parts: [{ type: "reasoning", text: "", carrier }, text("x")],
          },
          { role: "user", parts: [text("y")] },
        ],
      }),
    );
    assert.deepEqual(body.input[1], {
      type: "reasoning",
      summary: [],
      encrypted_content: "enc",
    });
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  });

  test("system images are dropped and counted", () => {
    const image = { type: "image", mediaType: "image/png", data: "AAAA" };
    const { body, dropped } = build(request({ system: [text("s"), image] }));
    assert.equal(body.instructions, "s");
    assert.ok(dropped.includes("system.image"));
  });

  test("identical IRs serialize identically", () => {
    const a = JSON.stringify(build(snapshot("mcp-tool-result")).body);
    const b = JSON.stringify(build(snapshot("mcp-tool-result")).body);
    assert.equal(a, b);
  });
});
