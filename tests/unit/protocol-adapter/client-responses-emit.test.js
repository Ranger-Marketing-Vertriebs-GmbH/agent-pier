import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  emitResponsesResponse,
  emitResponsesStream,
  emitResponsesStreamError,
  responsesKeepalive,
} from "../../../server/features/protocol-adapter/client-responses.js";
import { encodeCarrier } from "../../../server/features/protocol-adapter/carrier.js";
import { responsesErrorStream } from "../../../server/features/protocol-adapter/errors.js";
import { createSseParser } from "../../../server/features/protocol-adapter/sse.js";

const OPTIONS = { model: "gpt-client", responseId: "resp_test", includeEncrypted: true };
const CARRIER = encodeCarrier("messages", "signed-thinking");

async function* fromArray(events) {
  for (const event of events) yield event;
}

async function emitText(events, options = OPTIONS) {
  let text = "";
  for await (const chunk of emitResponsesStream(fromArray(events), options)) {
    text += chunk;
  }
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

/** Parsed events with the sequence numbers checked and removed. */
async function emitParsed(events, options) {
  const parsed = parseSse(await emitText(events, options));
  return parsed.map(({ sequence_number: sequence, ...rest }, index) => {
    assert.equal(sequence, index, "sequence numbers count up from 0");
    return rest;
  });
}

const frame = (data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;
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
const wireUsage = (input, output, cached = 0, reasoning = 0, cacheWrite = 0) => ({
  input_tokens: input,
  output_tokens: output,
  input_tokens_details: { cached_tokens: cached, cache_write_tokens: cacheWrite },
  output_tokens_details: { reasoning_tokens: reasoning },
  total_tokens: input + output,
});
const start = { type: "start", id: "upstream-id", model: "upstream-model" };
const stop = (reason) => ({ type: "stop", reason });
const textBlock = (index, ...parts) => [
  { type: "blockStart", index, kind: "text" },
  ...parts.map((text) => ({ type: "textDelta", index, text })),
  { type: "blockStop", index },
];
const toolStart = (index, toolCall) => ({
  type: "blockStart",
  index,
  kind: "toolCall",
  toolCall,
});
const input = (index, fragment) => ({ type: "toolInputDelta", index, fragment });

const shell = (status, extra = {}) => ({
  id: "resp_test",
  object: "response",
  model: "gpt-client",
  status,
  output: [],
  ...extra,
});
const created = { type: "response.created", response: shell("in_progress") };
const completed = (output, usageWire = wireUsage(0, 0)) => ({
  type: "response.completed",
  response: shell("completed", { output, usage: usageWire }),
});
const added = (outputIndex, item) => ({
  type: "response.output_item.added",
  output_index: outputIndex,
  item,
});
const done = (outputIndex, item) => ({
  type: "response.output_item.done",
  output_index: outputIndex,
  item,
});
const messageItem = (id, text) => ({
  type: "message",
  id,
  status: text === undefined ? "in_progress" : "completed",
  role: "assistant",
  content: text === undefined ? [] : [{ type: "output_text", text, annotations: [] }],
});
const textDelta = (itemId, outputIndex, delta) => ({
  type: "response.output_text.delta",
  item_id: itemId,
  output_index: outputIndex,
  content_index: 0,
  delta,
});
const functionItem = (id, callId, name, args, namespace) => ({
  type: "function_call",
  id,
  call_id: callId,
  name,
  ...(namespace ? { namespace } : {}),
  arguments: args,
});
const argsDelta = (itemId, outputIndex, delta) => ({
  type: "response.function_call_arguments.delta",
  item_id: itemId,
  output_index: outputIndex,
  delta,
});

function assertItemsPaired(events) {
  const addedIds = events
    .filter((event) => event.type === "response.output_item.added")
    .map((event) => [event.output_index, event.item.id]);
  const doneIds = events
    .filter((event) => event.type === "response.output_item.done")
    .map((event) => [event.output_index, event.item.id]);
  assert.deepEqual(doneIds, addedIds, "every added item has a matching done item");
  const final = events.at(-1);
  if (final.type === "response.completed") {
    const doneItems = events
      .filter((event) => event.type === "response.output_item.done")
      .map((event) => event.item);
    assert.deepEqual(final.response.output, doneItems);
  }
}

describe("emitResponsesStream", () => {
  test("text: exact SSE text, request model and response id echoed", async () => {
    const text = await emitText([
      start,
      usage(12, 0),
      ...textBlock(0, "Hel", "lo"),
      usage(12, 5),
      stop("end"),
    ]);
    const id = "msg_resp_test_0";
    const expected = [
      created,
      added(0, messageItem(id)),
      textDelta(id, 0, "Hel"),
      textDelta(id, 0, "lo"),
      done(0, messageItem(id, "Hello")),
      completed([messageItem(id, "Hello")], wireUsage(12, 5)),
    ].map((event, index) => {
      const { type, ...rest } = event;
      return { type, sequence_number: index, ...rest };
    });
    assert.equal(text, expected.map(frame).join(""));
    assert.deepEqual(parseSse(text), expected);
  });

  const reasoningEvents = (carrier) => [
    start,
    { type: "blockStart", index: 0, kind: "reasoning" },
    { type: "reasoningDelta", index: 0, summary: "Let me " },
    { type: "reasoningDelta", index: 0, summary: "think." },
    ...(carrier ? [{ type: "reasoningCarrier", index: 0, carrier }] : []),
    { type: "blockStop", index: 0 },
    ...textBlock(1, "Answer"),
    stop("end"),
  ];
  const summaryDelta = (delta) => ({
    type: "response.reasoning_summary_text.delta",
    item_id: "rs_resp_test_0",
    output_index: 0,
    summary_index: 0,
    delta,
  });
  const summaryDone = (text) => ({
    type: "response.reasoning_summary_text.done",
    item_id: "rs_resp_test_0",
    output_index: 0,
    summary_index: 0,
    text,
  });
  const reasoningItem = (text, encrypted) => ({
    type: "reasoning",
    id: "rs_resp_test_0",
    summary: text === undefined ? [] : [{ type: "summary_text", text }],
    ...(encrypted === undefined ? {} : { encrypted_content: encrypted }),
  });

  test("reasoning with a carrier sends it as encrypted_content", async () => {
    const events = await emitParsed(reasoningEvents(CARRIER));
    const reasoning = reasoningItem("Let me think.", CARRIER);
    const message = messageItem("msg_resp_test_1", "Answer");
    assert.deepEqual(events, [
      created,
      added(0, reasoningItem()),
      summaryDelta("Let me "),
      summaryDelta("think."),
      summaryDone("Let me think."),
      done(0, reasoning),
      added(1, messageItem("msg_resp_test_1")),
      textDelta("msg_resp_test_1", 1, "Answer"),
      done(1, message),
      completed([reasoning, message]),
    ]);
  });

  test("reasoning without a carrier gets an empty carrier of the origin", async () => {
    const events = await emitParsed(reasoningEvents(), { ...OPTIONS, origin: "chat" });
    assert.deepEqual(
      events[5],
      done(0, reasoningItem("Let me think.", encodeCarrier("chat", null))),
    );
  });

  test("encrypted_content is null when the client did not request it", async () => {
    const events = await emitParsed(reasoningEvents(CARRIER), {
      ...OPTIONS,
      includeEncrypted: false,
    });
    assert.deepEqual(events[5], done(0, reasoningItem("Let me think.", null)));
  });

  test("parallel function calls with interleaved deltas are serialized", async () => {
    const events = await emitParsed([
      start,
      ...textBlock(0, "Looking."),
      toolStart(1, { id: "call_a", name: "shell", kind: "function" }),
      input(1, '{"cmd":'),
      toolStart(2, { id: "call_b", name: "read", kind: "function" }),
      input(2, '{"path"'),
      input(1, '"ls"}'),
      input(2, ':"a.js"}'),
      { type: "blockStop", index: 2 },
      { type: "blockStop", index: 1 },
      usage(30, 9),
      stop("toolUse"),
    ]);
    const a = "fc_resp_test_1";
    const b = "fc_resp_test_2";
    assert.deepEqual(events.slice(4), [
      added(1, functionItem(a, "call_a", "shell", "")),
      argsDelta(a, 1, '{"cmd":'),
      argsDelta(a, 1, '"ls"}'),
      done(1, functionItem(a, "call_a", "shell", '{"cmd":"ls"}')),
      added(2, functionItem(b, "call_b", "read", "")),
      argsDelta(b, 2, '{"path"'),
      argsDelta(b, 2, ':"a.js"}'),
      done(2, functionItem(b, "call_b", "read", '{"path":"a.js"}')),
      completed(
        [
          messageItem("msg_resp_test_0", "Looking."),
          functionItem(a, "call_a", "shell", '{"cmd":"ls"}'),
          functionItem(b, "call_b", "read", '{"path":"a.js"}'),
        ],
        wireUsage(30, 9),
      ),
    ]);
    assertItemsPaired(events);
  });

  test("namespaced function call keeps its namespace", async () => {
    const events = await emitParsed([
      start,
      toolStart(0, {
        id: "call_m",
        name: "search",
        namespace: "mcp__docs__",
        kind: "function",
      }),
      input(0, '{"q":"x"}'),
      { type: "blockStop", index: 0 },
      stop("toolUse"),
    ]);
    const item = functionItem("fc_resp_test_0", "call_m", "search", '{"q":"x"}');
    assert.deepEqual(events[3], done(0, { ...item, namespace: "mcp__docs__" }));
    assert.equal(events[1].item.namespace, "mcp__docs__");
  });

  const patch = "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch";
  const customItem = (value) => ({
    type: "custom_tool_call",
    id: "ctc_resp_test_0",
    call_id: "call_p",
    name: "apply_patch",
    input: value,
  });
  const customDelta = (delta) => ({
    type: "response.custom_tool_call_input.delta",
    item_id: "ctc_resp_test_0",
    call_id: "call_p",
    output_index: 0,
    delta,
  });

  test("custom tool call streams its raw input", async () => {
    const events = await emitParsed([
      start,
      toolStart(0, { id: "call_p", name: "apply_patch", kind: "custom" }),
      input(0, patch.slice(0, 10)),
      input(0, patch.slice(10)),
      { type: "blockStop", index: 0 },
      stop("toolUse"),
    ]);
    assert.deepEqual(events, [
      created,
      added(0, customItem("")),
      customDelta(patch.slice(0, 10)),
      customDelta(patch.slice(10)),
      done(0, customItem(patch)),
      completed([customItem(patch)]),
    ]);
  });

  test("a function call for a declared custom tool is unwrapped", async () => {
    const wrapped = JSON.stringify({ input: patch });
    const events = await emitParsed(
      [
        start,
        toolStart(0, { id: "call_p", name: "apply_patch", kind: "function" }),
        input(0, wrapped.slice(0, 7)),
        input(0, wrapped.slice(7)),
        { type: "blockStop", index: 0 },
        stop("toolUse"),
      ],
      { ...OPTIONS, customTools: [{ name: "apply_patch", kind: "custom" }] },
    );
    assert.deepEqual(events, [
      created,
      added(0, customItem("")),
      customDelta(patch),
      done(0, customItem(patch)),
      completed([customItem(patch)]),
    ]);
  });

  test("length completes the response", async () => {
    const events = await emitParsed([start, ...textBlock(0, "cut"), stop("length")]);
    assert.equal(events.at(-1).type, "response.completed");
    assert.equal(events.at(-1).response.status, "completed");
  });

  test("refusal text is sent as output_text and completes", async () => {
    const events = await emitParsed([
      start,
      ...textBlock(0, "I can't."),
      stop("refusal"),
    ]);
    assert.deepEqual(
      events.at(-1),
      completed([messageItem("msg_resp_test_0", "I can't.")]),
    );
  });

  test("a refusal without text gets a fallback message item", async () => {
    const events = await emitParsed([start, stop("refusal")]);
    assert.equal(events[1].type, "response.output_item.added");
    assert.equal(events.at(-1).type, "response.completed");
    const [item] = events.at(-1).response.output;
    assert.equal(item.type, "message");
    assert.ok(item.content[0].text.length > 0);
    assertItemsPaired(events);
  });

  test("content filter fails with invalid_prompt", async () => {
    const events = await emitParsed([
      start,
      ...textBlock(0, "par"),
      stop("contentFilter"),
    ]);
    const final = events.at(-1);
    assert.equal(final.type, "response.failed");
    assert.equal(final.response.status, "failed");
    assert.equal(final.response.error.code, "invalid_prompt");
    assert.equal(events.at(-2).type, "response.output_item.done");
  });

  test("usage with cached and reasoning tokens", async () => {
    const events = await emitParsed([
      start,
      usage(30, 9, { cacheRead: 100, cacheWrite: 5, reasoning: 4 }),
      usage(30, 12, { cacheRead: 100, cacheWrite: 5, reasoning: 4 }),
      stop("end"),
    ]);
    assert.deepEqual(events.at(-1).response.usage, wireUsage(135, 12, 100, 4, 5));
  });

  test("mid-stream error after partial output fails the response", async () => {
    const error = { kind: "contextLength", status: 400, message: "too long" };
    const events = await emitParsed([
      start,
      { type: "blockStart", index: 0, kind: "text" },
      { type: "textDelta", index: 0, text: "par" },
      { type: "error", error },
      ...textBlock(1, "never"),
    ]);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "response.created",
        "response.output_item.added",
        "response.output_text.delta",
        "response.failed",
      ],
    );
    assert.deepEqual(events.at(-1).response.error, {
      code: "context_length_exceeded",
      message: "too long",
    });
  });

  test("an error before any output still starts with response.created", async () => {
    const error = { kind: "rateLimit", status: 429, message: "slow", retryAfter: 2 };
    const events = await emitParsed([start, { type: "error", error }]);
    assert.deepEqual(events[0], created);
    assert.equal(events[1].response.error.code, "rate_limit_exceeded");
  });

  test("a stream that ends without a stop event fails", async () => {
    const events = await emitParsed([start, ...textBlock(0, "x")]);
    const final = events.at(-1);
    assert.equal(final.type, "response.failed");
    assert.equal(final.response.error.code, "server_error");
  });

  test("buffered items still open at stop are flushed in order", async () => {
    const events = await emitParsed([
      start,
      { type: "blockStart", index: 0, kind: "text" },
      toolStart(1, { id: "call_a", name: "shell", kind: "function" }),
      input(1, "{}"),
      { type: "textDelta", index: 0, text: "x" },
      stop("toolUse"),
    ]);
    assertItemsPaired(events);
    assert.deepEqual(
      events.at(-1).response.output.map((item) => item.type),
      ["message", "function_call"],
    );
  });

  test("model and id fall back to the upstream start event", async () => {
    const events = await emitParsed([start, stop("end")], {});
    assert.equal(events[0].response.id, "upstream-id");
    assert.equal(events[0].response.model, "upstream-model");
  });

  test("invalid IR events are rejected", async () => {
    await assert.rejects(emitText([{ type: "bogus" }]), TypeError);
    await assert.rejects(
      emitText([start, { type: "textDelta", index: 3, text: "x" }]),
      /unknownBlockIndex/,
    );
  });
});

describe("emitResponsesResponse", () => {
  test("equals the response of response.completed", async () => {
    const events = [
      start,
      usage(3, 2),
      { type: "blockStart", index: 0, kind: "reasoning" },
      { type: "reasoningDelta", index: 0, text: "plan" },
      { type: "blockStop", index: 0 },
      ...textBlock(1, "Hi ", "there"),
      toolStart(2, { id: "call_a", name: "shell", kind: "function" }),
      input(2, "{}"),
      { type: "blockStop", index: 2 },
      stop("toolUse"),
    ];
    const response = await emitResponsesResponse(fromArray(events), OPTIONS);
    const streamed = await emitParsed(events);
    assert.deepEqual(response, streamed.at(-1).response);
    assert.equal(response.output.length, 3);
    assert.deepEqual(response.usage, wireUsage(3, 2));
  });

  test("rejects with the IR error when the upstream fails", async () => {
    const error = { kind: "overloaded", status: 529, message: "busy" };
    await assert.rejects(
      emitResponsesResponse(fromArray([start, { type: "error", error }]), OPTIONS),
      (thrown) => thrown.name === "AdapterUpstreamError" && thrown.error === error,
    );
  });

  test("rejects a content-filtered response as an invalid request", async () => {
    await assert.rejects(
      emitResponsesResponse(fromArray([start, stop("contentFilter")]), OPTIONS),
      (thrown) =>
        thrown.name === "AdapterUpstreamError" && thrown.error.kind === "invalidRequest",
    );
  });
});

describe("keepalive and stream errors", () => {
  test("keepalive is a response.in_progress data event", () => {
    const text = responsesKeepalive("resp_test");
    assert.equal(
      text,
      "event: response.in_progress\n" +
        'data: {"type":"response.in_progress","response":' +
        '{"id":"resp_test","object":"response","status":"in_progress"}}\n\n',
    );
    assert.equal(parseSse(text).length, 1);
  });

  test("emitResponsesStreamError renders created then failed", () => {
    const error = { kind: "contextLength", status: 400, message: "too long" };
    const options = { responseId: "resp_test", model: "gpt-client" };
    const text = emitResponsesStreamError(error, options);
    assert.equal(text, responsesErrorStream(error, options));
    assert.deepEqual(
      parseSse(text).map((event) => event.type),
      ["response.created", "response.failed"],
    );
  });
});
