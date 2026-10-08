import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assertResponsesStream } from "../helpers/protocol-adapter-shapes.js";
import {
  chatToolStream,
  clientBody,
  roundTrip,
  translator,
} from "../helpers/protocol-adapter-directions.js";

const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/** Messages stream with a parameterless tool_use: `input: {}` and no input_json_delta. */
const messagesEmptyToolStream = [
  event("message_start", {
    type: "message_start",
    message: {
      id: "msg_up_1",
      type: "message",
      role: "assistant",
      model: "claude-up",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  }),
  event("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_up_1", name: "get_goal", input: {} },
  }),
  event("content_block_stop", { type: "content_block_stop", index: 0 }),
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 5 },
  }),
  event("message_stop", { type: "message_stop" }),
].join("");

const callOf = (text) =>
  assertResponsesStream(text).items.find((item) => item.type === "function_call");

describe("parameterless tool calls toward Codex", () => {
  test("Messages tool_use without input text becomes arguments {}", async () => {
    const { text } = await roundTrip(
      translator("responses", "messages"),
      clientBody("clients/codex/function-call.json"),
      messagesEmptyToolStream,
      { seed: 3 },
    );
    const call = callOf(text);
    assert.equal(call.name, "get_goal");
    assert.equal(call.arguments, "{}");
  });

  test("Chat tool call with empty arguments becomes arguments {}", async () => {
    const { text } = await roundTrip(
      translator("responses", "chat"),
      clientBody("clients/codex/function-call.json"),
      chatToolStream({ id: "call_up_1", name: "get_goal", args: "" }),
      { seed: 5 },
    );
    assert.equal(callOf(text).arguments, "{}");
  });
});
