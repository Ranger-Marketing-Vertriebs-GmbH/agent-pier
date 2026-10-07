import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  emitResponsesResponse,
  emitResponsesStream,
  responsesKeepalive,
} from "../../../server/features/protocol-adapter/client-responses.js";
import { usageToOpenAI } from "../../../server/features/protocol-adapter/mapping.js";
import {
  assertResponsesStream,
  parseSseText,
} from "../../helpers/protocol-adapter-shapes.js";
import { fromChunks } from "../../helpers/protocol-adapter.js";

const OPTIONS = { model: "gpt-client", responseId: "resp_test" };
const start = { type: "start", id: "u1", model: "m" };
const stop = (reason = "end") => ({ type: "stop", reason });
const reasoning = (...deltas) => [
  { type: "blockStart", index: 0, kind: "reasoning" },
  ...deltas.map((delta) => ({ type: "reasoningDelta", index: 0, ...delta })),
  { type: "blockStop", index: 0 },
];

async function stream(events, options = {}) {
  let text = "";
  for await (const frame of emitResponsesStream(fromChunks(events), {
    ...OPTIONS,
    ...options,
  })) {
    text += frame;
  }
  const { items } = assertResponsesStream(text);
  return { items, events: parseSseText(text).map(({ data }) => data) };
}

const typesOf = (events, prefix) =>
  events.filter((event) => event.type.startsWith(prefix)).map((event) => event.type);

describe("reasoning summary and raw text are never mixed", () => {
  test("Responses origin: raw text goes to reasoning_text content when a summary arrives", async () => {
    const { items, events } = await stream(
      [
        start,
        ...reasoning({ text: "raw 1 " }, { summary: "Sum" }, { text: "raw 2" }),
        stop(),
      ],
      { origin: "responses" },
    );
    const summaries = events.filter(
      (event) => event.type === "response.reasoning_summary_text.delta",
    );
    assert.deepEqual(
      summaries.map((event) => event.delta),
      ["Sum"],
    );
    const raw = events.filter((event) => event.type === "response.reasoning_text.delta");
    assert.deepEqual(
      raw.map((event) => [event.delta, event.content_index]),
      [["raw 1 raw 2", 0]],
    );
    assert.deepEqual(items[0].summary, [{ type: "summary_text", text: "Sum" }]);
    assert.deepEqual(items[0].content, [{ type: "reasoning_text", text: "raw 1 raw 2" }]);
  });

  test("Responses origin: raw text without any summary becomes the summary at block end", async () => {
    const { items, events } = await stream(
      [start, ...reasoning({ text: "a" }, { text: "b" }), stop()],
      { origin: "responses" },
    );
    assert.deepEqual(typesOf(events, "response.reasoning"), [
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
    ]);
    assert.deepEqual(items[0].summary, [{ type: "summary_text", text: "ab" }]);
    assert.equal(items[0].content, undefined);
  });

  test("Chat origin streams raw text as the summary right away", async () => {
    const { items, events } = await stream(
      [start, ...reasoning({ text: "a" }, { text: "b" }), stop()],
      { origin: "chat" },
    );
    assert.deepEqual(typesOf(events, "response.reasoning"), [
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
    ]);
    assert.deepEqual(items[0].summary, [{ type: "summary_text", text: "ab" }]);
  });

  test("summary_text.done carries the full summary before the item is done", async () => {
    const { events } = await stream(
      [start, ...reasoning({ summary: "x" }, { summary: "y" }), stop()],
      { origin: "responses" },
    );
    const index = events.findIndex(
      (event) => event.type === "response.reasoning_summary_text.done",
    );
    assert.deepEqual(events[index], {
      type: "response.reasoning_summary_text.done",
      sequence_number: index,
      item_id: "rs_resp_test_0",
      output_index: 0,
      summary_index: 0,
      text: "xy",
    });
    assert.equal(events[index + 1].type, "response.output_item.done");
  });

  test("an empty reasoning block sends no summary done event", async () => {
    const { events } = await stream([start, ...reasoning(), stop()]);
    assert.deepEqual(typesOf(events, "response.reasoning"), []);
  });
});

describe("custom tool wrappers cut off by the upstream", () => {
  const call = (...fragments) => [
    start,
    {
      type: "blockStart",
      index: 0,
      kind: "toolCall",
      toolCall: { id: "c1", name: "apply_patch", kind: "function" },
    },
    ...fragments.map((fragment) => ({ type: "toolInputDelta", index: 0, fragment })),
    { type: "blockStop", index: 0 },
    stop("toolUse"),
  ];
  const options = { customTools: [{ name: "apply_patch" }] };
  const inputOf = async (...fragments) =>
    (
      await emitResponsesResponse(fromChunks(call(...fragments)), {
        ...OPTIONS,
        ...options,
      })
    ).output[0];

  test("a truncated wrapper is unwrapped to the partial string value", async () => {
    const item = await inputOf(
      '{"input": "*** Begin Patch\\n*** Add',
      ' File: a\\"b\\u00e9',
    );
    assert.equal(item.type, "custom_tool_call");
    assert.equal(item.input, '*** Begin Patch\n*** Add File: a"bé');
  });

  test("a dangling escape at the cut is dropped", async () => {
    assert.equal((await inputOf('{"input":"abc\\')).input, "abc");
    assert.equal((await inputOf('{"input":"abc\\u00')).input, "abc");
  });

  test("complete wrappers and raw input are unchanged", async () => {
    assert.equal((await inputOf('{"input":"done"}')).input, "done");
    assert.equal((await inputOf("*** Begin Patch")).input, "*** Begin Patch");
  });

  test("the stream path delivers the same unwrapped input", async () => {
    const { items } = await stream(call('{"input":"par'), options);
    assert.equal(items[0].input, "par");
  });
});

test("keep-alive frames carry no sequence_number", () => {
  const [{ data }] = parseSseText(responsesKeepalive("resp_test"));
  assert.equal(data.type, "response.in_progress");
  assert.equal(data.sequence_number, undefined);
});

test("usage reports cache writes as input_tokens_details.cache_write_tokens", () => {
  assert.deepEqual(
    usageToOpenAI({ input: 10, output: 5, cacheRead: 100, cacheWrite: 7, reasoning: 2 }),
    {
      input_tokens: 117,
      output_tokens: 5,
      input_tokens_details: { cached_tokens: 100, cache_write_tokens: 7 },
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 122,
    },
  );
});
