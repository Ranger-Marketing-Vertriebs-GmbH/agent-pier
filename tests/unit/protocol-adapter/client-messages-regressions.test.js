import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMessagesRequest } from "../../../server/features/protocol-adapter/client-messages.js";
import {
  createIdMap,
  createNameMap,
} from "../../../server/features/protocol-adapter/names.js";
import { buildMessagesRequest } from "../../../server/features/protocol-adapter/upstream-messages.js";
import { buildResponsesRequest } from "../../../server/features/protocol-adapter/upstream-responses.js";
import { buildChatRequest } from "../../../server/features/protocol-adapter/upstream-chat.js";

function body(overrides = {}) {
  return {
    model: "m",
    max_tokens: 1000,
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  };
}

const parse = (overrides) => parseMessagesRequest(body(overrides));

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

const WEB_SEARCH = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
  allowed_domains: ["example.com"],
};

describe("hosted web_search tools from Claude Code", () => {
  test("keep their versioned type and configuration in raw", () => {
    const { ir, dropped } = parse({ tools: [WEB_SEARCH] });
    assert.deepEqual(ir.tools, [
      { name: "web_search", kind: "hosted", hostedType: "web_search", raw: WEB_SEARCH },
    ]);
    assert.deepEqual(dropped, []);
  });

  test("are dropped and counted toward OpenAI upstreams, never sent as Anthropic tools", () => {
    const { ir } = parse({ tools: [WEB_SEARCH] });
    for (const build of [buildResponsesRequest, buildChatRequest]) {
      const built = build(ir, context());
      assert.equal(built.body.tools, undefined);
      assert.ok(built.dropped.includes("tools.web_search"));
    }
  });
});

describe("Claude Code request fields kept or counted", () => {
  const schema = { type: "object", properties: {} };

  test("tool strict is kept in the IR and honored by OpenAI targets", () => {
    const strictSchema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: {
          type: "array",
          items: {
            type: "object",
            properties: { c: { anyOf: [{ type: "number" }, { type: "null" }] } },
            required: ["c"],
            additionalProperties: false,
          },
        },
      },
      required: ["b", "a"],
      additionalProperties: false,
    };
    const { ir, dropped } = parse({
      tools: [{ name: "f", input_schema: strictSchema, strict: true }],
    });
    assert.equal(ir.tools[0].strict, true);
    assert.deepEqual(dropped, []);
    const responses = buildResponsesRequest(ir, context());
    const chat = buildChatRequest(ir, context());
    assert.equal(responses.body.tools[0].strict, true);
    assert.equal(chat.body.tools[0].function.strict, true);
    assert.ok(!responses.adjustments.includes("tools.strictDowngraded"));
    assert.ok(!chat.adjustments.includes("tools.strictDowngraded"));
    const invalid = parse({ tools: [{ name: "f", input_schema: schema, strict: "y" }] });
    assert.equal(invalid.ir.tools[0].strict, undefined);
    assert.deepEqual(invalid.dropped, ["tools.strict"]);
  });

  test("strict is downgraded and counted when the schema breaks OpenAI strict rules", () => {
    const optional = { type: "object", properties: { a: { type: "string" } } };
    const nestedOpen = {
      type: "object",
      properties: { a: { type: "object", properties: {}, required: [] } },
      required: ["a"],
      additionalProperties: false,
    };
    const missingRequired = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    };
    const allOf = {
      type: "object",
      properties: {},
      additionalProperties: false,
      allOf: [{ properties: {} }],
    };
    for (const input_schema of [schema, optional, nestedOpen, missingRequired, allOf]) {
      const { ir } = parse({ tools: [{ name: "f", input_schema, strict: true }] });
      const responses = buildResponsesRequest(ir, context());
      const chat = buildChatRequest(ir, context());
      assert.equal(responses.body.tools[0].strict, false);
      assert.equal(chat.body.tools[0].function.strict, false);
      assert.deepEqual(responses.adjustments, ["tools.strictDowngraded"]);
      assert.deepEqual(chat.adjustments, ["tools.strictDowngraded"]);
    }
  });

  test("tool_use input must be an object", () => {
    const messages = (input) => [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "f", input }] },
    ];
    for (const input of ["{}", 3, ["a"]]) {
      assert.throws(() => parse({ messages: messages(input) }), {
        name: "TypeError",
        message: /messages\[1\]\.content\[0\]\.input: expected an object/,
      });
    }
    const { ir } = parse({ messages: messages({ a: 1 }) });
    assert.equal(ir.messages[1].parts[0].input, '{"a":1}');
  });

  test("cache_control ttl is kept as cacheTtl and forwarded to Messages upstreams", () => {
    const { ir } = parse({
      system: [
        { type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      tools: [
        {
          name: "f",
          input_schema: schema,
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
    });
    assert.equal(ir.system[0].cacheTtl, "1h");
    assert.equal(ir.tools[0].cacheTtl, "5m");
    const built = buildMessagesRequest(ir, context());
    assert.deepEqual(built.body.system[0].cache_control, {
      type: "ephemeral",
      ttl: "1h",
    });
    assert.deepEqual(built.body.tools[0].cache_control, { type: "ephemeral", ttl: "5m" });
    assert.doesNotMatch(JSON.stringify(buildChatRequest(ir, context()).body), /ttl/);
    assert.doesNotMatch(JSON.stringify(buildResponsesRequest(ir, context()).body), /ttl/);
  });

  test("auto cache marks take the longest TTL of any later client mark", () => {
    const { ir } = parse({
      system: [{ type: "text", text: "s" }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a", cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
        },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
    });
    const { body, adjustments } = buildMessagesRequest(ir, context());
    assert.deepEqual(body.system[0].cache_control, { type: "ephemeral", ttl: "1h" });
    assert.deepEqual(body.messages[0].content[0].cache_control, {
      type: "ephemeral",
      ttl: "1h",
    });
    assert.deepEqual(body.messages.at(-1).content.at(-1).cache_control, {
      type: "ephemeral",
    });
    assert.ok(adjustments.includes("cache.autoBreakpoints"));
  });

  test("text citations and document/search_result blocks are counted", () => {
    const { ir, dropped } = parse({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "cited", citations: [{ type: "char_location" }] },
            { type: "document", source: { type: "text", data: "d" } },
            { type: "search_result", source: "s", title: "t", content: [] },
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [
                { type: "search_result", source: "s", title: "t", content: [] },
                { type: "document", source: { type: "text", data: "d" } },
              ],
            },
          ],
        },
      ],
    });
    assert.deepEqual(ir.messages[0].parts[0], { type: "text", text: "cited" });
    assert.deepEqual(dropped.sort(), [
      "content.document",
      "content.search_result",
      "text.citations",
      "tool_result.document",
      "tool_result.search_result",
    ]);
  });
});
