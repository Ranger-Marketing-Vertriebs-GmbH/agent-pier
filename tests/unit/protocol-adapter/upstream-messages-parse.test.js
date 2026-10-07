import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import {
  parseMessagesResponse,
  parseMessagesStream,
} from "../../../server/features/protocol-adapter/upstream-messages.js";
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

const SIGNATURE = "EqQBCkYIBxgCKkBfixtureSignature0123456789abcdefghijklmnop==";

function context(overrides = {}) {
  return {
    names: createNameMap({ pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 128 }),
    ids: createIdMap(/^[a-zA-Z0-9_-]+$/),
    capabilities: {},
    model: "upstream-model",
    sessionKey: "session-1",
    ...overrides,
  };
}

async function* sseEvents(chunks) {
  const parser = createSseParser();
  for (const chunk of chunks) yield* parser.push(chunk);
  yield* parser.end();
}

async function parseText(text, ctx = context(), sizes = []) {
  const events = await collect(
    parseMessagesStream(sseEvents(splitChunks(text, sizes)), ctx),
  );
  for (const event of events) assertIrEvent(event);
  return events;
}

const sse = (...items) =>
  items.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const MESSAGE = {
  id: "msg_t",
  type: "message",
  role: "assistant",
  model: "claude-t",
  content: [],
  stop_reason: null,
  usage: { input_tokens: 10, output_tokens: 1 },
};
const messageStart = { type: "message_start", message: MESSAGE };
const blockStart = (index, block) => ({
  type: "content_block_start",
  index,
  content_block: block,
});
const blockDelta = (index, delta) => ({ type: "content_block_delta", index, delta });
const blockStop = (index) => ({ type: "content_block_stop", index });
const messageDelta = (stop, usage = { output_tokens: 5 }) => ({
  type: "message_delta",
  delta: { stop_reason: stop, stop_sequence: null },
  usage,
});
const messageStop = { type: "message_stop" };

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
    } else if (event.type === "textDelta") {
      blocks.get(event.index).text += event.text;
    } else if (event.type === "reasoningDelta") {
      blocks.get(event.index).text += event.text ?? "";
    } else if (event.type === "toolInputDelta") {
      blocks.get(event.index).text += event.fragment;
    } else if (event.type === "reasoningCarrier") {
      blocks.get(event.index).carrier = event.carrier;
    } else if (event.type === "blockStop") {
      assert.ok(blocks.get(event.index).open, "a block stops once");
      blocks.get(event.index).open = false;
    }
  }
  const pick = (type) => events.filter((event) => event.type === type);
  return {
    start: pick("start").map(({ id, model }) => ({ id, model })),
    blocks: order,
    usage: pick("usage").map(({ type, ...usage }) => usage), // eslint-disable-line no-unused-vars
    stop: pick("stop").map(({ type, ...stop }) => stop), // eslint-disable-line no-unused-vars
    errors: pick("error").map((event) => event.error.kind),
  };
}

const usage = (input, output, extra = {}) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  estimated: false,
  ...extra,
});

describe("parseMessagesStream fixtures", () => {
  for (const name of fixtureList("upstreams/messages").filter((n) =>
    n.endsWith(".sse"),
  )) {
    test(`${name} is chunk-split invariant`, async () => {
      const text = loadFixture(name);
      const whole = summarize(await parseText(text));
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 1, max: 40 }), { maxLength: 60 }),
          async (sizes) => {
            const split = summarize(await parseText(text, context(), sizes));
            assert.deepEqual(split, whole);
          },
        ),
        { numRuns: 25 },
      );
      assert.equal(whole.stop.length + whole.errors.length, 1, "one terminal event");
      assert.ok(
        whole.blocks.every((block) => !block.open),
        "all blocks are closed",
      );
    });
  }

  test("text with cache usage and ping", async () => {
    const result = summarize(await parseText(loadFixture("upstreams/messages/text.sse")));
    assert.deepEqual(result, {
      start: [{ id: "msg_01FixtureUpstream", model: "claude-fixture-1" }],
      blocks: [{ kind: "text", text: "Hello from the fixture.", open: false }],
      usage: [usage(25, 9, { cacheRead: 2048, cacheWrite: 100 })],
      stop: [{ reason: "end" }],
      errors: [],
    });
  });

  test("thinking with signature becomes a messages carrier", async () => {
    const result = summarize(
      await parseText(loadFixture("upstreams/messages/thinking-text.sse")),
    );
    assert.equal(result.blocks[0].kind, "reasoning");
    assert.equal(result.blocks[0].text, "The user wants a greeting. Answer briefly.");
    assert.deepEqual(decodeCarrier(result.blocks[0].carrier), {
      origin: "messages",
      payload: SIGNATURE,
    });
    assert.equal(result.blocks[1].text, "Hello.");
    assert.deepEqual(result.usage, [usage(25, 30)]);
  });

  test("parallel tool use keeps arguments and ids", async () => {
    const result = summarize(
      await parseText(loadFixture("upstreams/messages/parallel-tool-use.sse")),
    );
    assert.deepEqual(
      result.blocks.slice(1).map(({ toolCall, text }) => ({ ...toolCall, text })),
      [
        {
          id: "toolu_01FixtureReadA",
          name: "Read",
          kind: "function",
          text: '{"file_path": "/workspace/a.txt"}',
        },
        {
          id: "toolu_01FixtureReadB",
          name: "Read",
          kind: "function",
          text: '{"file_path": "/workspace/b.txt"}',
        },
      ],
    );
    assert.deepEqual(result.stop, [{ reason: "toolUse" }]);
  });

  test("refusal and max_tokens stops", async () => {
    const refusal = summarize(
      await parseText(loadFixture("upstreams/messages/refusal.sse")),
    );
    assert.deepEqual(refusal.stop, [{ reason: "refusal" }]);
    assert.equal(refusal.blocks[0].text, "I can't help with that.");
    const cut = summarize(
      await parseText(loadFixture("upstreams/messages/max-tokens.sse")),
    );
    assert.deepEqual(cut.stop, [{ reason: "length" }]);
    assert.deepEqual(cut.usage, [usage(25, 16)]);
  });

  test("in-stream overloaded error ends the stream without stop", async () => {
    const events = await parseText(
      loadFixture("upstreams/messages/error-overloaded.sse"),
    );
    const result = summarize(events);
    assert.deepEqual(result.errors, ["overloaded"]);
    assert.deepEqual(result.stop, []);
    assert.equal(events.at(-1).type, "error");
  });

  test("truncated stream yields no stop", async () => {
    const text = sse(
      messageStart,
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "Hi" }),
      blockStop(0),
      messageDelta("end_turn"),
    );
    const result = summarize(await parseText(text));
    assert.deepEqual(result.stop, []);
    assert.deepEqual(result.errors, []);
  });

  test("redacted thinking round-trips through a marked carrier", async () => {
    const text = sse(
      messageStart,
      blockStart(0, { type: "redacted_thinking", data: "opaque-data" }),
      blockStop(0),
      messageDelta("end_turn"),
      messageStop,
    );
    const result = summarize(await parseText(text));
    assert.equal(result.blocks[0].kind, "reasoning");
    const carrier = decodeCarrier(result.blocks[0].carrier);
    assert.equal(carrier.origin, "messages");
    assert.notEqual(carrier.payload, "opaque-data");
    assert.ok(carrier.payload.endsWith("opaque-data"));
  });

  test("tool names and ids are mapped back; unknown blocks are skipped", async () => {
    const ctx = context();
    const name = ctx.names.toUpstream("lookup", "mcp__fixture");
    const id = ctx.ids.toUpstream("call.with.dots");
    const text = sse(
      messageStart,
      blockStart(0, { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" }),
      blockDelta(0, { type: "input_json_delta", partial_json: "{}" }),
      blockStop(0),
      blockStart(1, { type: "tool_use", id, name, input: {} }),
      blockDelta(1, { type: "input_json_delta", partial_json: '{"topic":"a"}' }),
      blockStop(1),
      { type: "some_future_event" },
      messageDelta("tool_use"),
      messageStop,
    );
    const result = summarize(await parseText(text, ctx));
    assert.equal(result.blocks.length, 1);
    assert.deepEqual(result.blocks[0].toolCall, {
      id: "call.with.dots",
      name: "lookup",
      namespace: "mcp__fixture",
      kind: "function",
    });
    assert.equal(result.blocks[0].text, '{"topic":"a"}');
  });

  test("tool input given only on block start is emitted once", async () => {
    const text = sse(
      messageStart,
      blockStart(0, { type: "tool_use", id: "toolu_1", name: "Bash", input: { a: 1 } }),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop,
    );
    const result = summarize(await parseText(text));
    assert.equal(result.blocks[0].text, '{"a":1}');
  });

  test("usage is cumulative and stop sequence is reported", async () => {
    const text = sse(
      messageStart,
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "x" }),
      blockStop(0),
      messageDelta("stop_sequence", { output_tokens: 3 }),
      {
        type: "message_delta",
        delta: { stop_reason: "stop_sequence", stop_sequence: "END" },
        usage: { output_tokens: 7 },
      },
      messageStop,
    );
    const result = summarize(await parseText(text));
    assert.deepEqual(result.usage.at(-1), usage(10, 7));
    assert.deepEqual(result.stop, [{ reason: "stopSequence", stopSequence: "END" }]);
  });

  test("unparsable data is an error", async () => {
    const result = summarize(await parseText("event: message_start\ndata: {oops\n\n"));
    assert.equal(result.errors.length, 1);
  });
});

describe("parseMessagesResponse", () => {
  test("non-stream message with thinking, text and tool use", () => {
    const { body } = loadFixture("upstreams/messages/non-stream.json");
    const events = parseMessagesResponse(body, context());
    for (const event of events) assertIrEvent(event);
    const result = summarize(events);
    assert.deepEqual(result.start, [
      { id: "msg_01FixtureUpstream", model: "claude-fixture-1" },
    ]);
    assert.deepEqual(
      result.blocks.map((block) => block.kind),
      ["reasoning", "text", "toolCall"],
    );
    assert.equal(decodeCarrier(result.blocks[0].carrier).payload, SIGNATURE);
    assert.equal(result.blocks[2].text, '{"command":"ls"}');
    assert.deepEqual(result.usage, [usage(25, 40, { cacheRead: 1024 })]);
    assert.deepEqual(result.stop, [{ reason: "toolUse" }]);
  });

  for (const [name, kind] of [
    ["overloaded", "overloaded"],
    ["rate-limit", "rateLimit"],
    ["prompt-too-long", "contextLength"],
  ]) {
    test(`error body ${name}`, () => {
      const { body } = loadFixture(`upstreams/messages/${name}.json`);
      const events = parseMessagesResponse(body, context());
      assert.equal(events.length, 1);
      assert.equal(events[0].type, "error");
      assert.equal(events[0].error.kind, kind);
    });
  }
});
