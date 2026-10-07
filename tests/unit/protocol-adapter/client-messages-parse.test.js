import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMessagesRequest } from "../../../server/features/protocol-adapter/client-messages.js";
import { assertIrRequest } from "../../../server/features/protocol-adapter/ir.js";
import { fixtureList, loadFixture } from "../../helpers/protocol-adapter.js";

const fixtures = fixtureList("clients/claude-code");

function body(overrides = {}) {
  return {
    model: "m",
    max_tokens: 1000,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

const parse = (overrides, headers) => parseMessagesRequest(body(overrides), headers);
const text = (value, extra = {}) => ({ type: "text", text: value, ...extra });

describe("recorded Claude Code requests", () => {
  for (const file of fixtures) {
    const name = file.split("/").pop();
    test(`${name} matches the reviewed IR snapshot`, () => {
      const { headers, body: request } = loadFixture(file);
      const result = parseMessagesRequest(request, headers);
      assert.doesNotThrow(() => assertIrRequest(result.ir));
      assert.deepEqual(result, loadFixture(`ir/claude-code/${name}`));
    });
  }

  test("every fixture keeps its trailing mid-conversation system message", () => {
    for (const file of fixtures) {
      const { headers, body: request } = loadFixture(file);
      const { ir } = parseMessagesRequest(request, headers);
      assert.equal(ir.messages.length, request.messages.length, file);
      assert.equal(ir.messages.at(-1).role, "system", file);
    }
  });
});

describe("messages", () => {
  test("mid-conversation system messages stay at their position", () => {
    const { ir } = parse({
      messages: [
        { role: "user", content: "a" },
        { role: "system", content: "between" },
        { role: "assistant", content: [{ type: "text", text: "b" }] },
        {
          role: "system",
          content: [{ type: "text", text: "late", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
    assert.deepEqual(ir.messages, [
      { role: "user", parts: [text("a")] },
      { role: "system", parts: [text("between")] },
      { role: "assistant", parts: [text("b")] },
      { role: "system", parts: [text("late", { cache: "ephemeral" })] },
    ]);
  });

  test("empty messages and empty text blocks are dropped", () => {
    const { ir } = parse({
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "" },
        { role: "assistant", content: [] },
        { role: "assistant", content: [{ type: "text", text: "" }] },
        { role: "user", content: "b" },
      ],
    });
    assert.deepEqual(ir.messages, [
      { role: "user", parts: [text("a")] },
      { role: "user", parts: [text("b")] },
    ]);
  });

  test("tool_use and tool_result with string, image and error content", () => {
    const image = { type: "base64", media_type: "image/png", data: "AAAA" };
    const { ir } = parse({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "toolu_2", name: "Read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "out",
              is_error: true,
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              content: [
                { type: "text", text: "shot" },
                { type: "image", source: image },
              ],
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
    });
    assert.deepEqual(ir.messages[1].parts, [
      {
        type: "toolCall",
        id: "toolu_1",
        name: "Bash",
        kind: "function",
        input: '{"command":"ls"}',
      },
      { type: "toolCall", id: "toolu_2", name: "Read", kind: "function", input: "{}" },
    ]);
    assert.deepEqual(ir.messages[2].parts, [
      { type: "toolResult", callId: "toolu_1", parts: [text("out")], isError: true },
      {
        type: "toolResult",
        callId: "toolu_2",
        parts: [text("shot"), { type: "image", mediaType: "image/png", data: "AAAA" }],
        isError: false,
        cache: "ephemeral",
      },
    ]);
  });

  test("tool_result without content and with unsupported blocks", () => {
    const { ir, dropped } = parse({
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a" },
            { type: "tool_result", tool_use_id: "b", content: [{ type: "document" }] },
          ],
        },
      ],
    });
    assert.deepEqual(
      ir.messages[0].parts.map((part) => part.parts),
      [[], []],
    );
    assert.deepEqual(dropped, ["tool_result.document"]);
  });

  test("thinking keeps the raw signature as carrier; redacted thinking keeps data", () => {
    const { ir } = parse({
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "ap1.chat.eyJ4IjoxfQ" },
            { type: "thinking", thinking: "", signature: "sig-native" },
            { type: "redacted_thinking", data: "opaque" },
            { type: "text", text: "a" },
          ],
        },
      ],
    });
    assert.deepEqual(ir.messages[1].parts, [
      { type: "reasoning", text: "hmm", carrier: "ap1.chat.eyJ4IjoxfQ" },
      { type: "reasoning", text: "", carrier: "sig-native" },
      { type: "reasoning", redacted: true, carrier: "opaque" },
      text("a"),
    ]);
  });

  test("images from base64 and url sources", () => {
    const { ir, dropped } = parse({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "/9j/" },
              cache_control: { type: "ephemeral" },
            },
            {
              type: "image",
              source: { type: "url", url: "https://example.test/a.PNG?x=1" },
            },
            { type: "image", source: { type: "url", url: "https://example.test/pic" } },
            { type: "image", source: { type: "file", file_id: "file_1" } },
          ],
        },
      ],
    });
    assert.deepEqual(ir.messages[0].parts, [
      { type: "image", mediaType: "image/jpeg", data: "/9j/", cache: "ephemeral" },
      { type: "image", mediaType: "image/png", url: "https://example.test/a.PNG?x=1" },
      {
        type: "image",
        mediaType: "application/octet-stream",
        url: "https://example.test/pic",
      },
    ]);
    assert.deepEqual(dropped, ["image.file"]);
  });

  test("unknown block types are dropped and counted, not fatal", () => {
    const { ir, dropped } = parse({
      messages: [
        {
          role: "user",
          content: [{ type: "document", source: {} }, text("keep")],
        },
        { role: "system", content: [{ type: "image", source: {} }, text("sys")] },
      ],
    });
    assert.deepEqual(ir.messages, [
      { role: "user", parts: [text("keep")] },
      { role: "system", parts: [text("sys")] },
    ]);
    assert.deepEqual(dropped, ["content.document", "content.image"]);
  });
});

describe("system", () => {
  test("string system becomes one text part", () => {
    assert.deepEqual(parse({ system: "be brief" }).ir.system, [text("be brief")]);
  });

  test("block system keeps cache marks; absent system is empty", () => {
    const { ir, dropped } = parse({
      system: [
        { type: "text", text: "a", cache_control: { type: "ephemeral" } },
        { type: "text", text: "b", cache_control: { type: "ephemeral", ttl: "1h" } },
        { type: "text", text: "c" },
      ],
    });
    assert.deepEqual(ir.system, [
      text("a", { cache: "ephemeral" }),
      text("b", { cache: "ephemeral" }),
      text("c"),
    ]);
    assert.deepEqual(dropped, ["cache_control.ttl"]);
    assert.deepEqual(parse().ir.system, []);
  });
});

describe("thinking", () => {
  const thinkingOf = (overrides) => parse(overrides);

  test("adaptive with display and effort (what Claude Code sends)", () => {
    const { ir, dropped } = thinkingOf({
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "high" },
    });
    assert.deepEqual(ir.thinking, {
      mode: "adaptive",
      effort: "high",
      display: "omitted",
    });
    assert.deepEqual(dropped, []);
  });

  test("display updates and summarized are kept", () => {
    for (const display of ["updates", "summarized"]) {
      const { ir, dropped } = thinkingOf({
        thinking: { type: "adaptive", display },
        output_config: { effort: "high" },
      });
      assert.deepEqual(ir.thinking, { mode: "adaptive", effort: "high", display });
      assert.deepEqual(dropped, []);
    }
  });

  test("unknown display and unknown effort are dropped and normalized", () => {
    const { ir, dropped } = thinkingOf({
      thinking: { type: "adaptive", display: "verbose" },
      output_config: { effort: "turbo" },
    });
    assert.deepEqual(ir.thinking, { mode: "adaptive", effort: "medium" });
    assert.deepEqual(dropped.sort(), ["output_config.effort", "thinking.display"]);
  });

  test("enabled with budget, disabled, between_tools, absent", () => {
    assert.deepEqual(
      thinkingOf({ thinking: { type: "enabled", budget_tokens: 4096 } }).ir.thinking,
      { mode: "enabled", budgetTokens: 4096 },
    );
    assert.deepEqual(thinkingOf({ thinking: { type: "disabled" } }).ir.thinking, {
      mode: "disabled",
    });
    assert.deepEqual(
      thinkingOf({
        thinking: { type: "between_tools" },
        output_config: { effort: "low" },
      }).ir.thinking,
      { mode: "between_tools", effort: "low" },
    );
    assert.equal(thinkingOf().ir.thinking, null);
  });

  test("effort without thinking and unknown thinking types are dropped", () => {
    const effortOnly = thinkingOf({ output_config: { effort: "max" } });
    assert.equal(effortOnly.ir.thinking, null);
    assert.deepEqual(effortOnly.dropped, ["output_config.effort"]);
    const unknown = thinkingOf({ thinking: { type: "dreaming" } });
    assert.equal(unknown.ir.thinking, null);
    assert.deepEqual(unknown.dropped, ["thinking"]);
  });

  test("enabled without a valid budget is rejected", () => {
    assert.throws(() => thinkingOf({ thinking: { type: "enabled" } }), {
      name: "TypeError",
      message: /thinking\.budget_tokens/,
    });
  });

  test("json_schema output format maps to IR output", () => {
    const schema = { type: "object", properties: {} };
    const { ir } = parse({ output_config: { format: { type: "json_schema", schema } } });
    assert.deepEqual(ir.output, { format: "json_schema", name: "output", schema });
    assert.equal(parse().ir.output, null);
  });
});

describe("tools and tool choice", () => {
  test("client tools carry schema, description and cache", () => {
    const schema = { type: "object", properties: { q: { type: "string" } } };
    const { ir, dropped } = parse({
      tools: [
        { name: "find", description: "Find", input_schema: schema },
        {
          name: "mcp__srv__long_tool",
          input_schema: schema,
          cache_control: { type: "ephemeral" },
          defer_loading: true,
        },
        { type: "web_search_20250305", name: "web_search", max_uses: 3 },
        { type: "bash_20250124", name: "bash" },
      ],
    });
    assert.deepEqual(ir.tools, [
      { name: "find", kind: "function", schema, description: "Find" },
      { name: "mcp__srv__long_tool", kind: "function", schema, cache: "ephemeral" },
      { name: "web_search", kind: "hosted", hostedType: "web_search" },
    ]);
    assert.deepEqual(dropped, ["tools.defer_loading", "tools.bash_20250124"]);
  });

  test("tool_choice variants and parallel tool use", () => {
    const choice = (tool_choice) => parse({ tool_choice }).ir;
    assert.equal(parse().ir.toolChoice, "auto");
    assert.equal(parse().ir.parallelToolCalls, null);
    assert.equal(choice({ type: "auto" }).toolChoice, "auto");
    assert.equal(choice({ type: "any" }).toolChoice, "required");
    assert.equal(choice({ type: "none" }).toolChoice, "none");
    assert.deepEqual(choice({ type: "tool", name: "find" }).toolChoice, { name: "find" });
    const serial = choice({ type: "auto", disable_parallel_tool_use: true });
    assert.equal(serial.parallelToolCalls, false);
    assert.equal(
      choice({ type: "any", disable_parallel_tool_use: false }).parallelToolCalls,
      true,
    );
    assert.equal(parse({ disable_parallel_tool_use: true }).ir.parallelToolCalls, false);
  });
});

describe("top-level fields", () => {
  test("sampling, stream and defaults", () => {
    const { ir, dropped } = parse({
      max_tokens: 2048,
      temperature: 0.2,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ["END"],
      stream: true,
    });
    assert.deepEqual(ir.sampling, {
      maxOutputTokens: 2048,
      temperature: 0.2,
      topP: 0.9,
      stop: ["END"],
    });
    assert.equal(ir.stream, true);
    assert.deepEqual(dropped, ["top_k"]);
    assert.deepEqual(parse({ max_tokens: undefined, stream: undefined }).ir.sampling, {
      maxOutputTokens: null,
      temperature: null,
      topP: null,
      stop: [],
    });
    assert.equal(parse().ir.stream, false);
    assert.deepEqual(parse().ir.cache, { key: null });
  });

  test("metadata, context management and the beta header become hints", () => {
    const { ir, dropped } = parse(
      {
        metadata: { user_id: "u" },
        context_management: { edits: [] },
        service_tier: "auto",
        safeguards: [{ type: "dangerous_tool_use" }],
        container: "c",
      },
      { "Anthropic-Beta": "a-1,b-2", "anthropic-version": "2023-06-01" },
    );
    assert.deepEqual(ir.hints, {
      metadata: { user_id: "u" },
      contextManagement: { edits: [] },
      serviceTier: "auto",
      anthropicBeta: "a-1,b-2",
    });
    assert.deepEqual(dropped, ["safeguards", "container"]);
    assert.deepEqual(parseMessagesRequest(body()).ir.hints, {});
  });

  test("malformed requests throw a TypeError naming the path", () => {
    const cases = [
      [null, /^body/],
      [{ ...body(), model: 1 }, /^model/],
      [{ ...body(), messages: "x" }, /^messages/],
      [{ ...body(), messages: [{ role: "tool", content: "x" }] }, /messages\[0\]\.role/],
      [{ ...body(), messages: [{ role: "user", content: 5 }] }, /messages\[0\]\.content/],
      [{ ...body(), max_tokens: 0 }, /maxOutputTokens/],
      [
        { ...body(), messages: [{ role: "user", content: [{ type: "text" }] }] },
        /messages\[0\]\.content\[0\]\.text/,
      ],
    ];
    for (const [request, message] of cases) {
      assert.throws(() => parseMessagesRequest(request), { name: "TypeError", message });
    }
  });
});
