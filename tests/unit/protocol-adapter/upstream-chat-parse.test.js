import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import {
  buildChatRequest,
  parseChatResponse,
  parseChatStream,
} from "../../../server/features/protocol-adapter/upstream-chat.js";
import { decodeCarrier } from "../../../server/features/protocol-adapter/carrier.js";
import { assertIrEvent } from "../../../server/features/protocol-adapter/ir.js";
import {
  createIdMap,
  createNameMap,
} from "../../../server/features/protocol-adapter/names.js";
import { createSseParser } from "../../../server/features/protocol-adapter/sse.js";
import {
  collect,
  fixtureList,
  loadFixture,
  splitChunks,
} from "../../helpers/protocol-adapter.js";

const CHAT_NAMES = { pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 64 };

function context(overrides = {}) {
  return {
    names: createNameMap(CHAT_NAMES),
    ids: createIdMap(/^[a-zA-Z0-9_-]+$/),
    capabilities: {},
    model: "upstream-model",
    sessionKey: "session-1",
    thinkTagExtraction: false,
    requestChars: 400,
    ...overrides,
  };
}

async function* sseEvents(chunks) {
  const parser = createSseParser();
  for (const chunk of chunks) yield* parser.push(chunk);
  yield* parser.end();
}

async function parseText(text, ctx = context(), sizes = []) {
  const events = await collect(parseChatStream(sseEvents(splitChunks(text, sizes)), ctx));
  for (const event of events) assertIrEvent(event);
  return events;
}

const frame = (data) =>
  `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
const chunk = (delta, extra = {}) => ({
  id: "chatcmpl-t",
  model: "m",
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});
const finish = (reason) => ({
  id: "chatcmpl-t",
  model: "m",
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
});
const sse = (...items) => items.map(frame).join("");

/** Summarizes events: block texts joined, so delta granularity does not matter. */
function summarize(events) {
  const blocks = new Map();
  const order = [];
  for (const event of events) {
    if (event.type === "blockStart") {
      const block = { kind: event.kind, text: "", open: true };
      if (event.toolCall) block.toolCall = event.toolCall;
      blocks.set(event.index, block);
      order.push(block);
    } else if (event.type === "textDelta" || event.type === "reasoningDelta") {
      blocks.get(event.index).text += event.text ?? "";
    } else if (event.type === "toolInputDelta") {
      blocks.get(event.index).text += event.fragment;
    } else if (event.type === "reasoningCarrier") {
      blocks.get(event.index).carrier = event.carrier;
    } else if (event.type === "blockStop") {
      blocks.get(event.index).open = false;
    }
  }
  const pick = (type) => events.filter((event) => event.type === type);
  return {
    blocks: order,
    usage: pick("usage").map(({ type, ...usage }) => usage), // eslint-disable-line no-unused-vars
    stop: pick("stop").map((event) => event.reason),
    errors: pick("error").map((event) => event.error.kind),
  };
}

const ESTIMATE = (output) => ({
  input: 100,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  estimated: true,
});

const EXPECTED = {
  "text.sse": {
    blocks: [{ kind: "text", text: "Hello from the fixture.", open: false }],
    usage: [ESTIMATE(6)],
    stop: ["end"],
    errors: [],
  },
  "reasoning-content.sse": {
    blocks: [
      {
        kind: "reasoning",
        text: "The user wants a greeting. Answer briefly.",
        open: false,
      },
      { kind: "text", text: "Hello.", open: false },
    ],
    usage: [ESTIMATE(12)],
    stop: ["end"],
    errors: [],
  },
  "think-inline.sse": {
    blocks: [
      {
        kind: "text",
        text: "<think>The user wants a greeting.</think>\n\nHello.",
        open: false,
      },
    ],
    usage: [ESTIMATE(13)],
    stop: ["end"],
    errors: [],
  },
  "parallel-tool-calls.sse": {
    blocks: [
      {
        kind: "toolCall",
        text: '{"path": "a.txt"}',
        open: false,
        toolCall: { id: "call_fixtureA", name: "read_file", kind: "function" },
      },
      {
        kind: "toolCall",
        text: '{"path": "b.txt"}',
        open: false,
        toolCall: { id: "call_fixtureB", name: "read_file", kind: "function" },
      },
    ],
    usage: [ESTIMATE(13)],
    stop: ["toolUse"],
    errors: [],
  },
  "tool-call-whole.sse": {
    blocks: [
      {
        kind: "toolCall",
        text: '{"path": "a.txt"}',
        open: false,
        toolCall: { id: "call_fixtureWhole", name: "read_file", kind: "function" },
      },
    ],
    usage: [ESTIMATE(7)],
    stop: ["toolUse"],
    errors: [],
  },
  "length.sse": {
    blocks: [{ kind: "text", text: "This answer is cut", open: false }],
    usage: [ESTIMATE(5)],
    stop: ["length"],
    errors: [],
  },
  "usage-cached.sse": {
    blocks: [{ kind: "text", text: "Cached hello.", open: false }],
    usage: [
      {
        input: 1024,
        output: 4,
        cacheRead: 3072,
        cacheWrite: 0,
        reasoning: 0,
        estimated: false,
      },
    ],
    stop: ["end"],
    errors: [],
  },
};
EXPECTED["reasoning.sse"] = EXPECTED["reasoning-content.sse"];

const streamFixtures = fixtureList("upstreams/chat").filter((file) =>
  file.endsWith(".sse"),
);

describe("Chat stream fixtures", () => {
  test("every stream fixture has an expectation", () => {
    for (const file of streamFixtures) {
      assert.ok(EXPECTED[file.split("/").pop()], file);
    }
  });

  for (const file of streamFixtures) {
    const name = file.split("/").pop();
    test(`${name} parses to the same IR at random chunk boundaries`, async () => {
      const text = loadFixture(file);
      const whole = await parseText(text);
      assert.deepEqual(summarize(whole), EXPECTED[name]);
      assert.deepEqual(whole[0], {
        type: "start",
        id: "chatcmpl-fixture",
        model: "qwen3-coder:30b",
      });
      assert.equal(whole.at(-1).type, "stop");
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 80 }),
          async (sizes) => {
            assert.deepEqual(await parseText(text, context(), sizes), whole);
          },
        ),
        { numRuns: 40 },
      );
    });
  }

  test("think-inline.sse with thinkTagExtraction yields reasoning and text", async () => {
    const events = await parseText(
      loadFixture("upstreams/chat/think-inline.sse"),
      context({ thinkTagExtraction: true }),
    );
    assert.deepEqual(summarize(events).blocks, [
      { kind: "reasoning", text: "The user wants a greeting.", open: false },
      { kind: "text", text: "Hello.", open: false },
    ]);
  });

  test("usage arrives after finish_reason and still precedes stop", async () => {
    const events = await parseText(loadFixture("upstreams/chat/usage-cached.sse"));
    const types = events.map((event) => event.type);
    assert.deepEqual(types.slice(-3), ["blockStop", "usage", "stop"]);
  });
});

describe("think tag extraction", () => {
  const content = "  <think>\nweigh options</think>\n\nThe answer: <think> stays.";

  test("is robust at every split of the content into deltas", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 60 }),
        async (sizes) => {
          const parts = splitChunks(content, sizes);
          const text = sse(
            ...parts.map((part) => chunk({ content: part })),
            finish("stop"),
            "[DONE]",
          );
          const events = await parseText(text, context({ thinkTagExtraction: true }));
          assert.deepEqual(summarize(events).blocks, [
            { kind: "reasoning", text: "weigh options", open: false },
            { kind: "text", text: "The answer: <think> stays.", open: false },
          ]);
        },
      ),
      { numRuns: 150 },
    );
  });

  test("text that does not start with <think> is passed through", async () => {
    const text = sse(
      chunk({ content: "<thi" }),
      chunk({ content: "s is text" }),
      finish("stop"),
    );
    const events = await parseText(text, context({ thinkTagExtraction: true }));
    assert.deepEqual(summarize(events).blocks, [
      { kind: "text", text: "<this is text", open: false },
    ]);
  });

  test("an unclosed think block ends as reasoning", async () => {
    const text = sse(chunk({ content: "<think>still thinking" }), finish("length"));
    const events = await parseText(text, context({ thinkTagExtraction: true }));
    assert.deepEqual(summarize(events).blocks, [
      { kind: "reasoning", text: "still thinking", open: false },
    ]);
  });

  test("a held prefix is flushed when the stream ends", async () => {
    const text = sse(chunk({ content: " <thi" }), finish("stop"));
    const events = await parseText(text, context({ thinkTagExtraction: true }));
    assert.deepEqual(summarize(events).blocks, [
      { kind: "text", text: " <thi", open: false },
    ]);
  });
});

describe("stream completion", () => {
  test("missing finish_reason: [DONE] after text synthesizes end", async () => {
    const events = await parseText(sse(chunk({ content: "hi" }), "[DONE]"));
    assert.deepEqual(summarize(events).stop, ["end"]);
  });

  test("missing finish_reason: [DONE] after a tool call synthesizes toolUse", async () => {
    const call = { index: 0, id: "c1", function: { name: "f", arguments: "{}" } };
    const events = await parseText(sse(chunk({ tool_calls: [call] }), "[DONE]"));
    assert.deepEqual(summarize(events).stop, ["toolUse"]);
  });

  test("a truncated stream without finish_reason and [DONE] has no stop", async () => {
    const events = await parseText(sse(chunk({ content: "partial" })));
    const summary = summarize(events);
    assert.deepEqual(summary.stop, []);
    assert.deepEqual(summary.usage, []);
  });

  test("finish_reason without [DONE] still stops", async () => {
    const events = await parseText(sse(chunk({ content: "hi" }), finish("stop")));
    assert.deepEqual(summarize(events).stop, ["end"]);
  });

  test("function_call and content_filter finish reasons", async () => {
    const a = await parseText(
      sse(chunk({ content: "x" }), finish("function_call"), "[DONE]"),
    );
    const b = await parseText(
      sse(chunk({ content: "x" }), finish("content_filter"), "[DONE]"),
    );
    assert.deepEqual(
      [summarize(a).stop, summarize(b).stop],
      [["toolUse"], ["contentFilter"]],
    );
  });

  test("events after [DONE] are ignored", async () => {
    const events = await parseText(
      sse(chunk({ content: "hi" }), finish("stop"), "[DONE]", chunk({ content: "late" })),
    );
    assert.equal(summarize(events).blocks[0].text, "hi");
  });

  test("usage on the finish chunk is used and not estimated", async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    const events = await parseText(
      sse(chunk({ content: "hi" }), { ...finish("stop"), usage }),
    );
    assert.deepEqual(summarize(events).usage, [
      {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        estimated: false,
      },
    ]);
  });

  test("cache writes and reasoning tokens are mapped", async () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 50 },
      completion_tokens_details: { reasoning_tokens: 7 },
    };
    const events = await parseText(
      sse(chunk({ content: "hi" }), finish("stop"), { choices: [], usage }, "[DONE]"),
    );
    assert.deepEqual(summarize(events).usage, [
      {
        input: 20,
        output: 20,
        cacheRead: 30,
        cacheWrite: 50,
        reasoning: 7,
        estimated: false,
      },
    ]);
  });

  test("the estimate counts reasoning and tool output; requestChars defaults to 0", async () => {
    const call = { index: 0, id: "c1", function: { name: "abcd", arguments: "{}" } };
    const text = sse(
      chunk({ reasoning_content: "1234" }),
      chunk({ tool_calls: [call] }),
      "[DONE]",
    );
    const events = await parseText(text, context({ requestChars: undefined }));
    assert.deepEqual(summarize(events).usage, [{ ...ESTIMATE(3), input: 0 }]);
  });
});

describe("tool calls", () => {
  test("names and ids are restored through the session maps", async () => {
    const ctx = context();
    const longName = `lookup_${"x".repeat(80)}`;
    const ir = {
      model: "m",
      system: [],
      messages: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
      tools: [{ name: longName, namespace: "mcp__srv", kind: "function", schema: {} }],
      toolChoice: "auto",
      parallelToolCalls: null,
      sampling: { maxOutputTokens: null, stop: [] },
      thinking: null,
      stream: true,
    };
    const upstreamName = buildChatRequest(ir, ctx).body.tools[0].function.name;
    const upstreamId = ctx.ids.toUpstream("toolu_original");
    const call = {
      index: 0,
      id: upstreamId,
      function: { name: upstreamName, arguments: "{}" },
    };
    const events = await parseText(
      sse(chunk({ tool_calls: [call] }), finish("tool_calls")),
      ctx,
    );
    assert.deepEqual(summarize(events).blocks[0].toolCall, {
      id: "toolu_original",
      name: longName,
      namespace: "mcp__srv",
      kind: "function",
    });
  });

  test("a name that arrives after argument fragments is waited for", async () => {
    const events = await parseText(
      sse(
        chunk({ tool_calls: [{ index: 0, id: "c1", function: { arguments: '{"a"' } }] }),
        chunk({
          tool_calls: [{ index: 0, function: { name: "late", arguments: ":1}" } }],
        }),
        finish("tool_calls"),
      ),
    );
    const [block] = summarize(events).blocks;
    assert.equal(block.toolCall.name, "late");
    assert.equal(block.text, '{"a":1}');
  });

  test("a call without id gets a stable synthesized id", async () => {
    const call = { index: 3, function: { name: "f", arguments: "{}" } };
    const events = await parseText(
      sse(chunk({ tool_calls: [call] }), finish("tool_calls")),
    );
    assert.equal(summarize(events).blocks[0].toolCall.id, "chatcmpl-t_call_3");
  });

  test("text before a tool call is closed before the call starts", async () => {
    const call = { index: 0, id: "c1", function: { name: "f", arguments: "{}" } };
    const events = await parseText(
      sse(
        chunk({ content: "Let me look." }),
        chunk({ tool_calls: [call] }),
        finish("tool_calls"),
      ),
    );
    const types = events.map((event) => `${event.type}:${event.index ?? ""}`);
    assert.ok(types.indexOf("blockStop:0") < types.indexOf("blockStart:1"));
  });
});

describe("reasoning and errors", () => {
  test("reasoningReplay attaches a chat carrier holding the reasoning text", async () => {
    const ctx = context({ capabilities: { reasoningReplay: true } });
    const text = loadFixture("upstreams/chat/reasoning-content.sse");
    const [reasoning] = summarize(await parseText(text, ctx)).blocks;
    assert.deepEqual(decodeCarrier(reasoning.carrier), {
      origin: "chat",
      payload: "The user wants a greeting. Answer briefly.",
    });
  });

  test("without reasoningReplay no carrier is emitted", async () => {
    const text = loadFixture("upstreams/chat/reasoning.sse");
    const events = await parseText(text);
    assert.ok(!events.some((event) => event.type === "reasoningCarrier"));
  });

  test("a mid-stream error object becomes an IR error and ends the stream", async () => {
    const { body } = loadFixture("upstreams/chat/context-vllm.json");
    const events = await parseText(
      sse(chunk({ content: "a" }), body, chunk({ content: "b" })),
    );
    const summary = summarize(events);
    assert.deepEqual(summary.errors, ["contextLength"]);
    assert.deepEqual(summary.stop, []);
    assert.equal(events.at(-1).type, "error");
  });

  test("a mid-stream error string (LM Studio) becomes an IR error", async () => {
    const { body } = loadFixture("upstreams/chat/context-lmstudio-unverified.json");
    const events = await parseText(sse(body));
    assert.deepEqual(summarize(events).errors, ["contextLength"]);
  });

  test("an event named error and invalid JSON are errors", async () => {
    const named = await parseText(`event: error\ndata: {"message":"boom"}\n\n`);
    const broken = await parseText(sse("{not json"));
    assert.deepEqual(
      [summarize(named).errors, summarize(broken).errors],
      [["server"], ["server"]],
    );
  });
});

describe("parseChatResponse", () => {
  const response = (message, extra = {}) => ({
    id: "chatcmpl-r",
    object: "chat.completion",
    model: "served",
    choices: [{ index: 0, message, finish_reason: "tool_calls" }],
    usage: {
      prompt_tokens: 50,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 10 },
    },
    ...extra,
  });

  test("reasoning, text and tool calls become ordered IR events", () => {
    const events = parseChatResponse(
      response({
        role: "assistant",
        reasoning_content: "think",
        content: "Calling.",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      }),
      context(),
    );
    for (const event of events) assertIrEvent(event);
    const summary = summarize(events);
    assert.deepEqual(events[0], { type: "start", id: "chatcmpl-r", model: "served" });
    assert.deepEqual(
      summary.blocks.map((block) => [block.kind, block.text]),
      [
        ["reasoning", "think"],
        ["text", "Calling."],
        ["toolCall", "{}"],
      ],
    );
    assert.deepEqual(summary.usage, [
      {
        input: 40,
        output: 5,
        cacheRead: 10,
        cacheWrite: 0,
        reasoning: 0,
        estimated: false,
      },
    ]);
    assert.deepEqual(summary.stop, ["toolUse"]);
  });

  test("missing finish_reason and usage are synthesized", () => {
    const json = response({ role: "assistant", content: "<think>t</think>ok" });
    delete json.choices[0].finish_reason;
    delete json.usage;
    const summary = summarize(
      parseChatResponse(json, context({ thinkTagExtraction: true })),
    );
    assert.deepEqual(
      summary.blocks.map((block) => [block.kind, block.text]),
      [
        ["reasoning", "t"],
        ["text", "ok"],
      ],
    );
    assert.deepEqual(summary.usage, [ESTIMATE(1)]);
    assert.deepEqual(summary.stop, ["end"]);
  });

  test("an error body becomes an IR error", () => {
    const { body } = loadFixture("upstreams/chat/context-llamacpp.json");
    assert.deepEqual(summarize(parseChatResponse(body, context())).errors, [
      "contextLength",
    ]);
  });
});
