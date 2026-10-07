import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  emitMessagesResponse,
  emitMessagesStream,
  emitMessagesStreamError,
  messagesPing,
} from "../../../server/features/protocol-adapter/client-messages.js";
import {
  decodeCarrier,
  encodeCarrier,
} from "../../../server/features/protocol-adapter/carrier.js";
import { messagesErrorEvent } from "../../../server/features/protocol-adapter/errors.js";
import { createSseParser } from "../../../server/features/protocol-adapter/sse.js";

const OPTIONS = { model: "claude-client-model", messageId: "msg_test" };
const CARRIER = encodeCarrier("responses", "opaque-replay");

async function* fromArray(events) {
  for (const event of events) yield event;
}

async function emitText(events, options = OPTIONS) {
  let text = "";
  for await (const chunk of emitMessagesStream(fromArray(events), options)) text += chunk;
  return text;
}

function parseSse(text) {
  const parser = createSseParser();
  return [...parser.push(text), ...parser.end()].map(({ event, data }) => {
    const payload = JSON.parse(data);
    assert.equal(payload.type, event, "event name matches data.type");
    return payload;
  });
}

async function emitParsed(events, options) {
  return parseSse(await emitText(events, options));
}

const usage = (input, output, extra = {}) => ({
  type: "usage",
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  estimated: false,
  ...extra,
});
const wireUsage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
});
const start = { type: "start", id: "upstream-id", model: "upstream-model" };
const textBlock = (index, ...parts) => [
  { type: "blockStart", index, kind: "text" },
  ...parts.map((text) => ({ type: "textDelta", index, text })),
  { type: "blockStop", index },
];
const messageStart = (input = 0, output = 0, cacheRead = 0) => ({
  type: "message_start",
  message: {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-client-model",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: wireUsage(input, output, cacheRead),
  },
});
const ending = (stopReason, usageWire, stopSequence = null) => [
  {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: stopSequence },
    usage: usageWire,
  },
  { type: "message_stop" },
];

/** Builds a Message object from parsed stream events, as a Messages SDK would. */
function collect(events) {
  let message;
  const partial = new Map();
  for (const event of events) {
    if (event.type === "message_start") message = structuredClone(event.message);
    if (event.type === "content_block_start") {
      message.content[event.index] = structuredClone(event.content_block);
    }
    if (event.type === "content_block_delta") {
      const block = message.content[event.index];
      const { delta } = event;
      if (delta.type === "text_delta") block.text += delta.text;
      if (delta.type === "thinking_delta") block.thinking += delta.thinking;
      if (delta.type === "signature_delta") block.signature = delta.signature;
      if (delta.type === "input_json_delta") {
        partial.set(event.index, (partial.get(event.index) ?? "") + delta.partial_json);
      }
    }
    if (event.type === "content_block_stop" && partial.has(event.index)) {
      message.content[event.index].input = JSON.parse(partial.get(event.index));
    }
    if (event.type === "message_delta") {
      Object.assign(message, event.delta);
      message.usage = event.usage;
    }
  }
  return message;
}

describe("emitMessagesStream", () => {
  test("text only: exact SSE text and order, request model echoed", async () => {
    const text = await emitText([
      start,
      usage(12, 0),
      ...textBlock(0, "Hel", "lo"),
      usage(12, 5),
      { type: "stop", reason: "end" },
    ]);
    const frame = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
    const expected = [
      messageStart(12),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hel" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "lo" },
      },
      { type: "content_block_stop", index: 0 },
      ...ending("end_turn", wireUsage(12, 5)),
    ];
    assert.equal(text, expected.map(frame).join(""));
    assert.deepEqual(parseSse(text), expected);
  });

  test("message_start carries zero input when usage is not known at start", async () => {
    const events = await emitParsed([
      start,
      ...textBlock(0, "x"),
      usage(7, 1),
      { type: "stop", reason: "end" },
    ]);
    assert.deepEqual(events[0], messageStart(0));
    assert.deepEqual(events.at(-2).usage, wireUsage(7, 1));
  });

  const thinkingEvents = [
    start,
    { type: "blockStart", index: 0, kind: "reasoning" },
    { type: "reasoningDelta", index: 0, text: "Let me " },
    { type: "reasoningDelta", index: 0, summary: "think." },
    { type: "reasoningCarrier", index: 0, carrier: CARRIER },
    { type: "blockStop", index: 0 },
    ...textBlock(1, "Answer"),
    { type: "stop", reason: "end" },
  ];
  const thinkingStart = {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "", signature: "" },
  };
  const signature = (value) => ({
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: value },
  });
  const thinkingDelta = (value) => ({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: value },
  });
  const afterThinking = [
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "Answer" },
    },
    { type: "content_block_stop", index: 1 },
    ...ending("end_turn", wireUsage(0, 0)),
  ];

  for (const display of [undefined, "summarized", "updates"]) {
    test(`thinking with carrier streams text under display ${display}`, async () => {
      const events = await emitParsed(thinkingEvents, { ...OPTIONS, display });
      assert.deepEqual(events, [
        messageStart(),
        thinkingStart,
        thinkingDelta("Let me "),
        thinkingDelta("think."),
        signature(CARRIER),
        ...afterThinking,
      ]);
    });
  }

  test("thinking under display omitted keeps only the carrier signature", async () => {
    const events = await emitParsed(thinkingEvents, { ...OPTIONS, display: "omitted" });
    assert.deepEqual(events, [
      messageStart(),
      thinkingStart,
      signature(CARRIER),
      ...afterThinking,
    ]);
  });

  test("reasoning without a carrier gets an empty carrier of the given origin", async () => {
    const events = [
      start,
      { type: "blockStart", index: 0, kind: "reasoning" },
      { type: "reasoningDelta", index: 0, text: "hm" },
      { type: "blockStop", index: 0 },
      { type: "stop", reason: "end" },
    ];
    const chat = await emitParsed(events);
    assert.deepEqual(chat[3], signature(encodeCarrier("chat", null)));
    const responses = await emitParsed(events, { ...OPTIONS, origin: "responses" });
    assert.deepEqual(decodeCarrier(responses[3].delta.signature), {
      origin: "responses",
      payload: null,
    });
  });

  const toolEvents = [
    start,
    ...textBlock(0, "Looking."),
    {
      type: "blockStart",
      index: 1,
      kind: "toolCall",
      toolCall: { id: "toolu_a", name: "Read", kind: "function" },
    },
    { type: "toolInputDelta", index: 1, fragment: '{"file_' },
    {
      type: "blockStart",
      index: 2,
      kind: "toolCall",
      toolCall: { id: "toolu_b", name: "Grep", kind: "function" },
    },
    { type: "toolInputDelta", index: 2, fragment: '{"pattern"' },
    { type: "toolInputDelta", index: 1, fragment: 'path":"a.js"}' },
    { type: "toolInputDelta", index: 2, fragment: ':"x"}' },
    { type: "blockStop", index: 2 },
    { type: "blockStop", index: 1 },
    usage(30, 9, { cacheRead: 100 }),
    { type: "stop", reason: "toolUse" },
  ];

  test("two parallel tool calls with split JSON are serialized block by block", async () => {
    const events = await emitParsed(toolEvents);
    const json = (index, partial) => ({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partial },
    });
    assert.deepEqual(events.slice(4), [
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_a", name: "Read", input: {} },
      },
      json(1, '{"file_'),
      json(1, 'path":"a.js"}'),
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_b", name: "Grep", input: {} },
      },
      json(2, '{"pattern"'),
      json(2, ':"x"}'),
      { type: "content_block_stop", index: 2 },
      ...ending("tool_use", wireUsage(30, 9, 100)),
    ]);
    assert.deepEqual(collect(events).content.slice(1), [
      { type: "tool_use", id: "toolu_a", name: "Read", input: { file_path: "a.js" } },
      { type: "tool_use", id: "toolu_b", name: "Grep", input: { pattern: "x" } },
    ]);
  });

  test("usage with cache read reaches message_start and message_delta", async () => {
    const events = await emitParsed([
      start,
      usage(4, 0, { cacheRead: 2048, cacheWrite: 16 }),
      ...textBlock(0, "ok"),
      usage(4, 3, { cacheRead: 2048, cacheWrite: 16 }),
      { type: "stop", reason: "end" },
    ]);
    assert.deepEqual(events[0].message.usage, wireUsage(4, 0, 2048, 16));
    assert.deepEqual(events.at(-2).usage, wireUsage(4, 3, 2048, 16));
  });

  test("length stop maps to max_tokens", async () => {
    const events = await emitParsed([
      start,
      ...textBlock(0, "cut"),
      { type: "stop", reason: "length" },
    ]);
    assert.deepEqual(events.slice(-2), ending("max_tokens", wireUsage(0, 0)));
  });

  for (const reason of ["refusal", "contentFilter"]) {
    test(`${reason} stop maps to refusal`, async () => {
      const events = await emitParsed([start, { type: "stop", reason }]);
      assert.deepEqual(events, [messageStart(), ...ending("refusal", wireUsage(0, 0))]);
    });
  }

  test("stop sequence is reported", async () => {
    const events = await emitParsed([
      start,
      { type: "stop", reason: "stopSequence", stopSequence: "END" },
    ]);
    assert.deepEqual(events.at(-2).delta, {
      stop_reason: "stop_sequence",
      stop_sequence: "END",
    });
  });

  test("an open block is closed before message_delta", async () => {
    const events = await emitParsed([
      start,
      { type: "blockStart", index: 0, kind: "text" },
      { type: "textDelta", index: 0, text: "a" },
      { type: "stop", reason: "end" },
    ]);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ],
    );
  });

  test("mid-stream error after partial text ends without message_stop", async () => {
    const error = { kind: "overloaded", status: 529, message: "Overloaded" };
    const text = await emitText([
      start,
      { type: "blockStart", index: 0, kind: "text" },
      { type: "textDelta", index: 0, text: "partial" },
      { type: "error", error },
      { type: "textDelta", index: 0, text: "ignored" },
      { type: "stop", reason: "end" },
    ]);
    assert.ok(text.endsWith(messagesErrorEvent(error)));
    const events = parseSse(text);
    assert.deepEqual(
      events.map((event) => event.type),
      ["message_start", "content_block_start", "content_block_delta", "error"],
    );
    assert.deepEqual(events.at(-1).error, {
      type: "overloaded_error",
      message: "Overloaded",
    });
  });

  test("a stream that ends without a stop event ends with an error", async () => {
    const events = await emitParsed([start, ...textBlock(0, "half")]);
    assert.equal(events.at(-1).type, "error");
    assert.ok(!events.some((event) => event.type === "message_stop"));
    assert.ok(!events.some((event) => event.type === "message_delta"));
  });

  test("custom tool calls cannot occur on the Claude Code path", async () => {
    const events = [
      start,
      {
        type: "blockStart",
        index: 0,
        kind: "toolCall",
        toolCall: { id: "call_1", name: "apply_patch", kind: "custom" },
      },
    ];
    await assert.rejects(emitText(events), new TypeError("unexpectedCustomToolCall"));
    await assert.rejects(
      emitMessagesResponse(fromArray(events), OPTIONS),
      new TypeError("unexpectedCustomToolCall"),
    );
  });

  test("invalid IR events are rejected", async () => {
    await assert.rejects(emitText([{ type: "textDelta", index: 0 }]), TypeError);
    await assert.rejects(
      emitText([start, { type: "textDelta", index: 3, text: "x" }]),
      new TypeError("unknownBlockIndex"),
    );
  });

  test("buffered blocks still open at stop are flushed and closed in order", async () => {
    const events = await emitParsed([
      start,
      { type: "blockStart", index: 0, kind: "text" },
      { type: "blockStart", index: 1, kind: "reasoning" },
      { type: "reasoningDelta", index: 1, text: "r" },
      { type: "textDelta", index: 0, text: "t" },
      { type: "stop", reason: "end" },
    ]);
    assert.deepEqual(
      events.slice(1, -2).map((event) => [event.type, event.index, event.delta?.type]),
      [
        ["content_block_start", 0, undefined],
        ["content_block_delta", 0, "text_delta"],
        ["content_block_stop", 0, undefined],
        ["content_block_start", 1, undefined],
        ["content_block_delta", 1, "thinking_delta"],
        ["content_block_delta", 1, "signature_delta"],
        ["content_block_stop", 1, undefined],
      ],
    );
  });

  test("model and id fall back to the upstream start event", async () => {
    const events = await emitParsed([start, { type: "stop", reason: "end" }], {});
    assert.equal(events[0].message.model, "upstream-model");
    assert.equal(events[0].message.id, "upstream-id");
  });
});

describe("emitMessagesResponse", () => {
  const textEvents = [
    start,
    usage(3, 0),
    ...textBlock(0, "Hi ", "there"),
    { type: "stop", reason: "end" },
  ];

  test("equals the collected stream for text", async () => {
    const response = await emitMessagesResponse(fromArray(textEvents), OPTIONS);
    assert.deepEqual(response, collect(await emitParsed(textEvents)));
    assert.deepEqual(response, {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-client-model",
      content: [{ type: "text", text: "Hi there" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: wireUsage(3, 0),
    });
  });

  test("equals the collected stream for thinking and parallel tool calls", async () => {
    const events = [
      start,
      { type: "blockStart", index: 0, kind: "reasoning" },
      { type: "reasoningDelta", index: 0, text: "plan" },
      { type: "reasoningCarrier", index: 0, carrier: CARRIER },
      { type: "blockStop", index: 0 },
      ...toolEventsAfterStart(),
    ];
    for (const display of ["omitted", "summarized"]) {
      const options = { ...OPTIONS, display };
      const response = await emitMessagesResponse(fromArray(events), options);
      assert.deepEqual(response, collect(await emitParsed(events, options)));
      assert.deepEqual(response.content[0], {
        type: "thinking",
        thinking: display === "omitted" ? "" : "plan",
        signature: CARRIER,
      });
      assert.equal(response.stop_reason, "tool_use");
      assert.deepEqual(response.usage, wireUsage(30, 9, 100));
    }
  });

  test("rejects with the IR error when the upstream fails", async () => {
    const error = { kind: "rateLimit", status: 429, message: "slow down", retryAfter: 3 };
    await assert.rejects(
      emitMessagesResponse(
        fromArray([start, ...textBlock(0, "x"), { type: "error", error }]),
      ),
      (thrown) => thrown.name === "AdapterUpstreamError" && thrown.error === error,
    );
  });
});

function toolEventsAfterStart() {
  return [
    {
      type: "blockStart",
      index: 1,
      kind: "toolCall",
      toolCall: { id: "toolu_a", name: "Read", kind: "function" },
    },
    {
      type: "blockStart",
      index: 2,
      kind: "toolCall",
      toolCall: { id: "toolu_b", name: "Grep", kind: "function" },
    },
    { type: "toolInputDelta", index: 2, fragment: '{"pattern":"x"}' },
    { type: "toolInputDelta", index: 1, fragment: '{"file_path":"a.js"}' },
    { type: "blockStop", index: 1 },
    { type: "blockStop", index: 2 },
    usage(30, 9, { cacheRead: 100 }),
    { type: "stop", reason: "toolUse" },
  ];
}

describe("ping and stream errors", () => {
  test("ping is the exact Messages ping frame", () => {
    assert.equal(messagesPing(), 'event: ping\ndata: {"type":"ping"}\n\n');
  });

  test("emitMessagesStreamError renders the Messages error event", () => {
    const error = { kind: "server", status: 500, message: "boom" };
    assert.equal(emitMessagesStreamError(error), messagesErrorEvent(error));
    assert.deepEqual(parseSse(emitMessagesStreamError(error)), [
      { type: "error", error: { type: "api_error", message: "boom" } },
    ]);
  });
});
