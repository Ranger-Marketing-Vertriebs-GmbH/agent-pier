import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fc from "fast-check";
import {
  parseResponsesResponse,
  parseResponsesStream,
} from "../../../server/features/protocol-adapter/upstream-responses.js";
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

function context(overrides = {}) {
  return {
    names: createNameMap({ pattern: /^[a-zA-Z0-9_-]+$/, maxLength: 64 }),
    ids: createIdMap(/^[a-zA-Z0-9_-]+$/),
    capabilities: {},
    model: "upstream-model",
    sessionKey: "session-1",
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
  const events = await collect(
    parseResponsesStream(sseEvents(splitChunks(text, sizes)), ctx),
  );
  for (const event of events) assertIrEvent(event);
  return events;
}

const sse = (...items) =>
  items.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const RESPONSE = { id: "resp_t", model: "m", status: "in_progress", output: [] };
const created = { type: "response.created", response: RESPONSE };
const USAGE = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 15,
};
const completed = (extra = {}) => ({
  type: "response.completed",
  response: { ...RESPONSE, status: "completed", usage: USAGE, ...extra },
});
const itemDone = (index, item) => ({
  type: "response.output_item.done",
  output_index: index,
  item,
});
const itemAdded = (index, item) => ({
  type: "response.output_item.added",
  output_index: index,
  item,
});

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
      blocks.get(event.index).text += event.summary ?? event.text ?? "";
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
    stop: pick("stop").map((event) => event.reason),
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

describe("parseResponsesStream fixtures", () => {
  for (const name of fixtureList("upstreams/responses")) {
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
      const total = whole.stop.length + whole.errors.length;
      assert.equal(total, 1, "exactly one terminal event");
      assert.ok(
        whole.blocks.every((block) => !block.open),
        "all blocks are closed",
      );
    });
  }

  test("text", async () => {
    const result = summarize(
      await parseText(loadFixture("upstreams/responses/text.sse")),
    );
    assert.deepEqual(result, {
      start: [{ id: "resp_fixture_upstream", model: "gpt-fixture-1" }],
      blocks: [{ kind: "text", text: "Hello from the fixture.", open: false }],
      usage: [usage(30, 6)],
      stop: ["end"],
      errors: [],
    });
  });

  test("cached usage excludes cached tokens from input", async () => {
    const result = summarize(
      await parseText(loadFixture("upstreams/responses/cached-usage.sse")),
    );
    assert.deepEqual(result.usage, [usage(1024, 4, { cacheRead: 3072 })]);
  });

  test("function calls stream their arguments exactly once", async () => {
    const events = await parseText(loadFixture("upstreams/responses/function-calls.sse"));
    const result = summarize(events);
    assert.deepEqual(
      result.blocks.map(({ toolCall, text }) => ({ ...toolCall, text })),
      [
        {
          id: "call_fixtureA",
          name: "exec_command",
          kind: "function",
          text: '{"cmd":"ls a"}',
        },
        {
          id: "call_fixtureB",
          name: "exec_command",
          kind: "function",
          text: '{"cmd":"ls b"}',
        },
      ],
    );
    assert.deepEqual(result.stop, ["toolUse"]);
    assert.ok(events.filter((event) => event.type === "toolInputDelta").length >= 4);
  });

  test("custom tool calls keep the raw input", async () => {
    const result = summarize(
      await parseText(loadFixture("upstreams/responses/custom-tool-call.sse")),
    );
    assert.deepEqual(result.blocks[0].toolCall, {
      id: "call_fixturePatch",
      name: "apply_patch",
      kind: "custom",
    });
    assert.equal(
      result.blocks[0].text,
      "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch\n",
    );
    assert.deepEqual(result.stop, ["toolUse"]);
  });

  test("reasoning summary and encrypted content become a carrier", async () => {
    const events = await parseText(
      loadFixture("upstreams/responses/reasoning-summary.sse"),
    );
    const deltas = events.filter((event) => event.type === "reasoningDelta");
    assert.ok(deltas.every((event) => typeof event.summary === "string"));
    const result = summarize(events);
    assert.equal(result.blocks[0].kind, "reasoning");
    assert.equal(result.blocks[0].text, "**Planning**\n\nAnswer with a greeting.");
    assert.deepEqual(decodeCarrier(result.blocks[0].carrier), {
      origin: "responses",
      payload: "gAAAAABfixtureEncryptedReasoningContent0123456789==",
    });
    assert.equal(result.blocks[1].text, "Hello.");
    assert.deepEqual(result.usage, [usage(40, 52, { reasoning: 44 })]);
  });

  test("incomplete max_output_tokens is length", async () => {
    const result = summarize(
      await parseText(
        loadFixture("upstreams/responses/incomplete-max-output-tokens.sse"),
      ),
    );
    assert.deepEqual(result.stop, ["length"]);
    assert.equal(result.blocks[0].text, "This answer is cut");
    assert.deepEqual(result.usage, [usage(30, 16)]);
  });

  test("failed context length is an error without stop", async () => {
    const events = await parseText(
      loadFixture("upstreams/responses/failed-context-length.sse"),
    );
    const error = events.find((event) => event.type === "error").error;
    assert.equal(error.kind, "contextLength");
    assert.match(error.message, /context window/);
    assert.equal(events.at(-1).type, "error");
  });
});

describe("parseResponsesStream edge cases", () => {
  test("a stream without a terminal event yields no stop", async () => {
    const text = loadFixture("upstreams/responses/text.sse");
    const truncated = text.slice(0, text.indexOf("event: response.completed"));
    const result = summarize(await parseText(truncated));
    assert.deepEqual(result.stop, []);
    assert.deepEqual(result.usage, []);
    assert.ok(result.blocks.every((block) => !block.open));
  });

  test("calls without call_id get ids unique per request and call", async () => {
    const call = (index) => ({ type: "function_call", id: `fc_${index}`, name: "f" });
    const text = sse(created, itemDone(0, call(0)), itemDone(1, call(1)), completed());
    const ids = (events) => summarize(events).blocks.map((block) => block.toolCall.id);
    assert.deepEqual(ids(await parseText(text, context({ requestId: "req_a" }))), [
      "call_req_a_0",
      "call_req_a_1",
    ]);
    assert.deepEqual(ids(await parseText(text, context({ requestId: "req_b" }))), [
      "call_req_b_0",
      "call_req_b_1",
    ]);
  });

  test("tool calls without deltas emit the done arguments once", async () => {
    const call = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "f",
      arguments: '{"a":1}',
    };
    const result = summarize(
      await parseText(sse(created, itemDone(0, call), completed())),
    );
    assert.equal(result.blocks.length, 1);
    assert.equal(result.blocks[0].text, '{"a":1}');
    assert.deepEqual(result.stop, ["toolUse"]);
  });

  test("done arguments complete partial deltas without duplication", async () => {
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "f" };
    const result = summarize(
      await parseText(
        sse(
          created,
          itemAdded(0, { ...call, arguments: "" }),
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: "fc_1",
            delta: '{"a"',
          },
          itemDone(0, { ...call, arguments: '{"a":1}' }),
          completed(),
        ),
      ),
    );
    assert.equal(result.blocks[0].text, '{"a":1}');
  });

  test("mapped names and ids are restored", async () => {
    const ctx = context();
    const long = `mcp__server__${"x".repeat(80)}`;
    const upstreamName = ctx.names.toUpstream(long);
    const upstreamId = ctx.ids.toUpstream("toolu.1");
    const call = {
      type: "function_call",
      call_id: upstreamId,
      name: upstreamName,
      arguments: "{}",
    };
    const result = summarize(
      await parseText(sse(created, itemDone(0, call), completed()), ctx),
    );
    assert.deepEqual(result.blocks[0].toolCall, {
      id: "toolu.1",
      name: long,
      kind: "function",
    });
  });

  test("refusal parts become text with a refusal stop", async () => {
    const item = {
      type: "message",
      id: "msg_r",
      role: "assistant",
      content: [{ type: "refusal", refusal: "I can't help with that." }],
    };
    const streamed = await parseText(
      sse(
        created,
        itemAdded(0, { ...item, content: [] }),
        {
          type: "response.refusal.delta",
          output_index: 0,
          item_id: "msg_r",
          content_index: 0,
          delta: "I can't help",
        },
        {
          type: "response.refusal.delta",
          output_index: 0,
          item_id: "msg_r",
          delta: " with that.",
        },
        itemDone(0, item),
        completed(),
      ),
    );
    const result = summarize(streamed);
    assert.equal(result.blocks[0].text, "I can't help with that.");
    assert.deepEqual(result.stop, ["refusal"]);
    const whole = summarize(
      await parseText(sse(created, itemDone(0, item), completed())),
    );
    assert.deepEqual(whole.blocks, result.blocks);
    assert.deepEqual(whole.stop, ["refusal"]);
  });

  test("incomplete content_filter is contentFilter", async () => {
    const result = summarize(
      await parseText(
        sse(created, {
          type: "response.incomplete",
          response: {
            ...RESPONSE,
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
            usage: USAGE,
          },
        }),
      ),
    );
    assert.deepEqual(result.stop, ["contentFilter"]);
  });

  test("error events become IR errors", async () => {
    const result = summarize(
      await parseText(
        sse(created, {
          type: "error",
          code: "rate_limit_exceeded",
          message: "Rate limit reached. Please try again in 2s.",
        }),
      ),
    );
    assert.deepEqual(result.errors, ["rateLimit"]);
    assert.deepEqual(result.stop, []);
  });

  test("unparseable data is an error", async () => {
    const result = summarize(await parseText("event: response.created\ndata: {oops\n\n"));
    assert.equal(result.errors.length, 1);
  });

  test("missing usage is estimated", async () => {
    const done = completed();
    delete done.response.usage;
    const events = await parseText(
      sse(
        created,
        { type: "response.output_text.delta", output_index: 0, delta: "12345678" },
        done,
      ),
    );
    assert.deepEqual(summarize(events).usage, [usage(100, 2, { estimated: true })]);
  });

  test("summary parts are separated by a blank line; raw reasoning text is read", async () => {
    const delta = (index, text) => ({
      type: "response.reasoning_summary_text.delta",
      output_index: 0,
      summary_index: index,
      delta: text,
    });
    const events = await parseText(
      sse(
        created,
        delta(0, "One."),
        delta(1, "Two."),
        itemDone(0, {
          type: "reasoning",
          summary: [
            { type: "summary_text", text: "One." },
            { type: "summary_text", text: "Two." },
          ],
        }),
        { type: "response.reasoning_text.delta", output_index: 1, delta: "raw" },
        completed(),
      ),
    );
    const result = summarize(events);
    assert.equal(result.blocks[0].text, "One.\n\nTwo.");
    assert.equal(result.blocks[0].carrier, undefined);
    assert.equal(result.blocks[1].text, "raw");
    assert.deepEqual(result.stop, ["end"]);
  });

  test("events after the terminal event are ignored", async () => {
    const events = await parseText(
      sse(created, completed(), { type: "response.output_text.delta", delta: "late" }),
    );
    assert.equal(events.at(-1).type, "stop");
    assert.equal(events.filter((event) => event.type === "textDelta").length, 0);
  });
});

describe("parseResponsesResponse", () => {
  test("a completed response yields the same events as its stream", async () => {
    const text = loadFixture("upstreams/responses/reasoning-summary.sse");
    const final = JSON.parse(text.trim().split("\n").at(-1).slice("data: ".length));
    const events = parseResponsesResponse(final.response, context());
    for (const event of events) assertIrEvent(event);
    const streamed = summarize(await parseText(text));
    assert.deepEqual(summarize(events), streamed);
  });

  test("function calls in a response", () => {
    const events = parseResponsesResponse(
      {
        ...RESPONSE,
        status: "completed",
        usage: USAGE,
        output: [{ type: "function_call", call_id: "c", name: "f", arguments: "{}" }],
      },
      context(),
    );
    const result = summarize(events);
    assert.equal(result.blocks[0].text, "{}");
    assert.deepEqual(result.stop, ["toolUse"]);
  });

  test("failed responses and error bodies are errors", () => {
    const failed = parseResponsesResponse(
      {
        ...RESPONSE,
        status: "failed",
        error: { code: "server_error", message: "boom" },
      },
      context(),
    );
    assert.deepEqual(summarize(failed).errors, ["server"]);
    const body = parseResponsesResponse(
      { error: { type: "invalid_request_error", message: "bad" } },
      context(),
    );
    assert.deepEqual(summarize(body).errors, ["invalidRequest"]);
    assert.deepEqual(
      summarize(parseResponsesResponse("nope", context())).errors.length,
      1,
    );
  });

  test("incomplete responses map their reason", () => {
    const events = parseResponsesResponse(
      {
        ...RESPONSE,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      },
      context(),
    );
    assert.deepEqual(summarize(events).stop, ["length"]);
  });
});
