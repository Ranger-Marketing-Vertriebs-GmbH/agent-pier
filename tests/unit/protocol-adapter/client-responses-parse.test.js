import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseResponsesRequest } from "../../../server/features/protocol-adapter/client-responses.js";
import { assertIrRequest } from "../../../server/features/protocol-adapter/ir.js";
import { fixtureList, loadFixture } from "../../helpers/protocol-adapter.js";

const fixtures = fixtureList("clients/codex");

function body(overrides = {}) {
  return {
    model: "m",
    input: [{ type: "message", role: "user", content: [inputText("hi")] }],
    ...overrides,
  };
}

const parse = (overrides, headers) => parseResponsesRequest(body(overrides), headers);
const text = (value) => ({ type: "text", text: value });
const inputText = (value) => ({ type: "input_text", text: value });
const message = (role, ...content) => ({ type: "message", role, content });
const user = (value) => message("user", inputText(value));

describe("recorded Codex requests", () => {
  for (const file of fixtures) {
    const name = file.split("/").pop();
    test(`${name} matches the reviewed IR snapshot`, () => {
      const { headers, body: request } = loadFixture(file);
      const result = parseResponsesRequest(request, headers);
      assert.doesNotThrow(() => assertIrRequest(result.ir));
      assert.deepEqual(result, loadFixture(`ir/codex/${name}`));
    });
  }

  test("every fixture moves its leading developer message into system", () => {
    for (const file of fixtures) {
      const { headers, body: request } = loadFixture(file);
      const { ir, rejected } = parseResponsesRequest(request, headers);
      assert.equal(rejected, undefined, file);
      assert.equal(ir.system.length, request.input[0].content.length, file);
      assert.equal(ir.messages[0].role, "user", file);
      assert.equal(ir.cache.key, request.prompt_cache_key, file);
    }
  });
});

describe("instructions and messages", () => {
  test("instructions come first; leading developer and system messages join system", () => {
    const { ir } = parse({
      instructions: "base",
      input: [
        message("developer", inputText("dev")),
        message("system", inputText("sys")),
        user("q"),
        message("developer", inputText("late")),
        message("assistant", { type: "output_text", text: "a" }),
      ],
    });
    assert.deepEqual(ir.system, [text("base"), text("dev"), text("sys")]);
    assert.deepEqual(ir.messages, [
      { role: "user", parts: [text("q")] },
      { role: "system", parts: [text("late")] },
      { role: "assistant", parts: [text("a")] },
    ]);
  });

  test("empty instructions, string input and string content", () => {
    const { ir } = parseResponsesRequest({
      model: "m",
      instructions: "",
      input: "hello",
    });
    assert.deepEqual(ir.system, []);
    assert.deepEqual(ir.messages, [{ role: "user", parts: [text("hello")] }]);
    const typeless = parse({ input: [{ role: "user", content: "plain" }] });
    assert.deepEqual(typeless.ir.messages, [{ role: "user", parts: [text("plain")] }]);
  });

  test("refusal parts become text; empty text and unknown parts are dropped", () => {
    const { ir, dropped } = parse({
      input: [
        user("q"),
        message(
          "assistant",
          { type: "refusal", refusal: "no" },
          { type: "output_text", text: "" },
          { type: "input_audio", input_audio: {} },
        ),
        message("user", inputText("")),
      ],
    });
    assert.deepEqual(ir.messages, [
      { role: "user", parts: [text("q")] },
      { role: "assistant", parts: [text("no")] },
    ]);
    assert.deepEqual(dropped, ["content.input_audio"]);
  });

  test("images from data URLs and URLs keep their detail", () => {
    const { ir, dropped } = parse({
      input: [
        message(
          "user",
          {
            type: "input_image",
            image_url: "data:image/png;base64,AAAA",
            detail: "high",
          },
          { type: "input_image", image_url: "https://example.test/a.jpg" },
          { type: "input_image", file_id: "file_1" },
        ),
      ],
    });
    assert.deepEqual(ir.messages[0].parts, [
      { type: "image", mediaType: "image/png", data: "AAAA", detail: "high" },
      { type: "image", mediaType: "image/jpeg", url: "https://example.test/a.jpg" },
    ]);
    assert.deepEqual(dropped, ["input_image.file_id"]);
  });

  test("unknown roles throw; unknown item types are dropped and counted", () => {
    assert.throws(() => parse({ input: [message("tool", inputText("x"))] }), {
      name: "TypeError",
      message: /input\[0\]\.role/,
    });
    const { ir, dropped } = parse({
      input: [user("q"), { type: "compaction", encrypted_content: "x" }],
    });
    assert.equal(ir.messages.length, 1);
    assert.deepEqual(dropped, ["input.compaction"]);
  });
});

describe("tool calls, outputs and reasoning", () => {
  test("assistant-side items merge into one assistant message", () => {
    const { ir } = parse({
      input: [
        user("q"),
        {
          type: "reasoning",
          id: "rs_1",
          summary: [
            { type: "summary_text", text: "one" },
            { type: "summary_text", text: "two" },
          ],
          content: [{ type: "reasoning_text", text: "raw" }],
          encrypted_content: "enc",
        },
        message("assistant", { type: "output_text", text: "doing" }),
        {
          type: "function_call",
          id: "fc_1",
          name: "lookup",
          namespace: "mcp__srv__",
          arguments: '{"a":1}',
          call_id: "call_1",
        },
        {
          type: "custom_tool_call",
          status: "completed",
          call_id: "call_2",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
        { type: "function_call_output", call_id: "call_1", output: "out" },
        {
          type: "custom_tool_call_output",
          call_id: "call_2",
          output: [
            inputText("done"),
            { type: "input_image", image_url: "data:image/gif;base64,R0lG" },
          ],
        },
        user("next"),
      ],
    });
    assert.deepEqual(ir.messages, [
      { role: "user", parts: [text("q")] },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "raw", summary: "one\n\ntwo", carrier: "enc" },
          text("doing"),
          {
            type: "toolCall",
            id: "call_1",
            name: "lookup",
            namespace: "mcp__srv__",
            kind: "function",
            input: '{"a":1}',
          },
          {
            type: "toolCall",
            id: "call_2",
            name: "apply_patch",
            kind: "custom",
            input: "*** Begin Patch",
          },
        ],
      },
      {
        role: "user",
        parts: [
          { type: "toolResult", callId: "call_1", parts: [text("out")], isError: false },
          {
            type: "toolResult",
            callId: "call_2",
            parts: [
              text("done"),
              { type: "image", mediaType: "image/gif", data: "R0lG" },
            ],
            isError: false,
          },
        ],
      },
      { role: "user", parts: [text("next")] },
    ]);
  });

  test("reasoning without summary or encrypted content stays an empty reasoning part", () => {
    const { ir } = parse({
      input: [
        user("q"),
        { type: "reasoning", summary: [], content: null, encrypted_content: null },
      ],
    });
    assert.deepEqual(ir.messages[1], {
      role: "assistant",
      parts: [{ type: "reasoning" }],
    });
  });

  test("empty tool output becomes an empty part list", () => {
    const { ir } = parse({
      input: [{ type: "function_call_output", call_id: "c", output: "" }],
    });
    assert.deepEqual(ir.messages[0].parts[0].parts, []);
  });
});

describe("tools and tool choice", () => {
  const schema = { type: "object", properties: {} };

  test("function, custom, namespace and hosted tools", () => {
    const webSearch = { type: "web_search", external_web_access: false };
    const { ir, dropped } = parse({
      tools: [
        {
          type: "function",
          name: "f",
          description: "F",
          strict: false,
          parameters: schema,
        },
        { type: "function", name: "lazy", parameters: schema, defer_loading: true },
        {
          type: "custom",
          name: "apply_patch",
          description: "P",
          format: { type: "grammar", syntax: "lark", definition: "start: x" },
        },
        { type: "custom", name: "free" },
        {
          type: "namespace",
          name: "mcp__srv__",
          description: "Server",
          tools: [
            { type: "function", name: "a", parameters: schema },
            { type: "custom", name: "b", format: { type: "text" } },
          ],
        },
        webSearch,
        { type: "tool_search", execution: "client", parameters: schema },
      ],
    });
    assert.deepEqual(ir.tools, [
      { name: "f", kind: "function", schema, description: "F", strict: false },
      { name: "lazy", kind: "function", schema },
      {
        name: "apply_patch",
        kind: "custom",
        description: "P",
        grammar: { syntax: "lark", definition: "start: x" },
      },
      { name: "free", kind: "custom" },
      { name: "a", namespace: "mcp__srv__", kind: "function", schema },
      { name: "b", namespace: "mcp__srv__", kind: "custom" },
      { name: "web_search", kind: "hosted", hostedType: "web_search", raw: webSearch },
      {
        name: "tool_search",
        kind: "hosted",
        hostedType: "tool_search",
        raw: { type: "tool_search", execution: "client", parameters: schema },
      },
    ]);
    assert.deepEqual(ir.hints.namespaceDescriptions, { mcp__srv__: "Server" });
    assert.deepEqual(dropped, ["tools.defer_loading"]);
  });

  test("tool_choice variants and parallel tool calls", () => {
    const choice = (tool_choice) => parse({ tool_choice }).ir.toolChoice;
    assert.equal(parse().ir.toolChoice, "auto");
    assert.equal(parse().ir.parallelToolCalls, null);
    for (const value of ["auto", "none", "required"]) assert.equal(choice(value), value);
    assert.deepEqual(choice({ type: "function", name: "f" }), { name: "f" });
    assert.deepEqual(choice({ type: "custom", name: "apply_patch" }), {
      name: "apply_patch",
    });
    const hosted = parse({ tool_choice: { type: "web_search" } });
    assert.equal(hosted.ir.toolChoice, "auto");
    assert.deepEqual(hosted.dropped, ["tool_choice"]);
    assert.equal(parse({ parallel_tool_calls: false }).ir.parallelToolCalls, false);
  });

  test("malformed tools throw a TypeError naming the path", () => {
    assert.throws(() => parse({ tools: [{ type: "function" }] }), {
      name: "TypeError",
      message: /tools\[0\]\.name/,
    });
    assert.throws(() => parse({ tools: [{ name: "x" }] }), {
      name: "TypeError",
      message: /tools\[0\]\.type/,
    });
  });
});

describe("reasoning settings", () => {
  const thinkingOf = (reasoning) => parse({ reasoning });

  test("effort and summary map to enabled thinking", () => {
    assert.deepEqual(thinkingOf({ effort: "high", summary: "auto" }).ir.thinking, {
      mode: "enabled",
      effort: "high",
      summary: "auto",
    });
    for (const summary of ["concise", "detailed"]) {
      assert.equal(thinkingOf({ effort: "low", summary }).ir.thinking.summary, "auto");
    }
    assert.deepEqual(thinkingOf({ effort: "medium" }).ir.thinking, {
      mode: "enabled",
      effort: "medium",
      summary: "none",
    });
    assert.equal(
      thinkingOf({ effort: "low", summary: "none" }).ir.thinking.summary,
      "none",
    );
    assert.equal(thinkingOf({ effort: "ultra" }).ir.thinking.effort, "max");
    assert.equal(parse().ir.thinking, null);
  });

  test("effort none disables thinking", () => {
    assert.deepEqual(thinkingOf({ effort: "none", summary: "auto" }).ir.thinking, {
      mode: "disabled",
    });
  });

  test("numeric and unknown efforts become medium and are counted", () => {
    for (const effort of [4096, "turbo"]) {
      const { ir, dropped } = thinkingOf({ effort });
      assert.equal(ir.thinking.effort, "medium");
      assert.deepEqual(dropped, ["reasoning.effort.unknown"]);
    }
  });

  test("reasoning.context becomes a hint; unknown summary is counted", () => {
    const { ir, dropped } = thinkingOf({
      effort: "low",
      summary: "verbose",
      context: "all_turns",
    });
    assert.equal(ir.thinking.summary, "none");
    assert.equal(ir.hints.reasoningContext, "all_turns");
    assert.deepEqual(dropped, ["reasoning.summary"]);
  });
});

describe("top-level fields", () => {
  test("sampling, stream, cache key and hints", () => {
    const { ir, dropped } = parse({
      max_output_tokens: 2048,
      temperature: 0.3,
      top_p: 0.8,
      stream: true,
      store: false,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "k",
      service_tier: "priority",
      client_metadata: { session_id: "s" },
      text: { verbosity: "low" },
      metadata: { a: "b" },
      user: "u",
      access_programs: ["x"],
      stream_options: { reasoning_summary_delivery: "sequential_cutoff" },
      truncation: "auto",
    });
    assert.deepEqual(ir.sampling, {
      maxOutputTokens: 2048,
      temperature: 0.3,
      topP: 0.8,
      stop: [],
    });
    assert.equal(ir.stream, true);
    assert.deepEqual(ir.cache, { key: "k" });
    assert.deepEqual(ir.hints, {
      store: false,
      include: ["reasoning.encrypted_content"],
      serviceTier: "priority",
      clientMetadata: { session_id: "s" },
      verbosity: "low",
      metadata: { a: "b" },
      user: "u",
    });
    assert.deepEqual(dropped.sort(), ["access_programs", "stream_options", "truncation"]);
  });

  test("defaults for a minimal request", () => {
    const { ir, dropped } = parse();
    assert.deepEqual(ir.sampling, {
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      stop: [],
    });
    assert.equal(ir.stream, false);
    assert.deepEqual(ir.cache, { key: null });
    assert.deepEqual(ir.hints, {});
    assert.equal(ir.output, null);
    assert.deepEqual(dropped, []);
  });

  test("json_schema text format maps to IR output", () => {
    const schema = { type: "object", properties: {} };
    const { ir } = parse({
      text: {
        format: {
          type: "json_schema",
          name: "codex_output_schema",
          strict: true,
          schema,
        },
      },
    });
    assert.deepEqual(ir.output, {
      format: "json_schema",
      name: "codex_output_schema",
      schema,
      strict: true,
    });
    assert.equal(parse({ text: { format: { type: "text" } } }).ir.output, null);
    const unknown = parse({ text: { format: { type: "json_object" } } });
    assert.equal(unknown.ir.output, null);
    assert.deepEqual(unknown.dropped, ["text.format"]);
  });

  test("previous_response_id is rejected as an invalid request", () => {
    const { ir, rejected } = parse({ previous_response_id: "resp_1" });
    assert.equal(ir.model, "m");
    assert.equal(rejected.kind, "invalidRequest");
    assert.equal(rejected.status, 400);
    assert.match(rejected.message, /previous_response_id/);
    assert.equal(parse({ previous_response_id: null }).rejected, undefined);
  });

  test("malformed requests throw a TypeError naming the path", () => {
    const cases = [
      [null, /^body/],
      [{ ...body(), model: 1 }, /^model/],
      [{ ...body(), input: 5 }, /^input/],
      [{ ...body(), input: [5] }, /input\[0\]/],
      [{ ...body(), max_output_tokens: 0 }, /maxOutputTokens/],
      [
        { ...body(), input: [{ type: "function_call", name: "f" }] },
        /input\[0\]\.call_id/,
      ],
      [
        { ...body(), input: [message("user", { type: "input_text" })] },
        /content\[0\]\.text/,
      ],
    ];
    for (const [request, pattern] of cases) {
      assert.throws(() => parseResponsesRequest(request), {
        name: "TypeError",
        message: pattern,
      });
    }
  });
});
