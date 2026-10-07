import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  emitMessagesResponse,
  emitMessagesStream,
} from "../../../server/features/protocol-adapter/client-messages.js";
import {
  emitResponsesResponse,
  emitResponsesStream,
} from "../../../server/features/protocol-adapter/client-responses.js";
import { collect, fromChunks } from "../../helpers/protocol-adapter.js";

const start = { type: "start", id: "u1", model: "m" };
const stop = (reason = "end") => ({ type: "stop", reason });
const toolStart = (index, id = "c1", name = "f") => ({
  type: "blockStart",
  index,
  kind: "toolCall",
  toolCall: { id, name, kind: "function" },
});

describe("emitters reject deltas that do not match the block kind", () => {
  const mismatches = [
    [
      { type: "blockStart", index: 0, kind: "text" },
      { type: "toolInputDelta", index: 0, fragment: "{" },
    ],
    [
      { type: "blockStart", index: 0, kind: "text" },
      { type: "reasoningDelta", index: 0, text: "t" },
    ],
    [
      { type: "blockStart", index: 0, kind: "reasoning" },
      { type: "textDelta", index: 0, text: "t" },
    ],
    [toolStart(0), { type: "textDelta", index: 0, text: "t" }],
    [toolStart(0), { type: "reasoningCarrier", index: 0, carrier: "ap1.chat." }],
  ];

  for (const [name, emit] of [
    ["Messages", emitMessagesStream],
    ["Responses", emitResponsesStream],
  ]) {
    test(name, async () => {
      for (const [blockStart, delta] of mismatches) {
        await assert.rejects(collect(emit(fromChunks([start, blockStart, delta]))), {
          name: "TypeError",
          message: "deltaKindMismatch",
        });
      }
    });

    test(`${name}: a mismatch on a buffered block is rejected immediately`, async () => {
      const events = [
        start,
        { type: "blockStart", index: 0, kind: "text" },
        { type: "blockStart", index: 1, kind: "reasoning" },
        { type: "toolInputDelta", index: 1, fragment: "{" },
      ];
      await assert.rejects(collect(emit(fromChunks(events))), {
        message: "deltaKindMismatch",
      });
    });
  }

  test("matching deltas still pass", async () => {
    const events = [
      start,
      { type: "blockStart", index: 0, kind: "text" },
      { type: "textDelta", index: 0, text: "hi" },
      { type: "blockStop", index: 0 },
      stop(),
    ];
    const message = await emitMessagesResponse(fromChunks(events));
    assert.equal(message.content[0].text, "hi");
    const response = await emitResponsesResponse(fromChunks(events));
    assert.equal(response.output[0].content[0].text, "hi");
  });
});

describe("non-streaming Messages response with invalid tool arguments", () => {
  for (const fragment of ["{bad", "[1,2]", '"text"', "null"]) {
    test(`${fragment} degrades to an empty input`, async () => {
      const message = await emitMessagesResponse(
        fromChunks([
          start,
          toolStart(0),
          { type: "toolInputDelta", index: 0, fragment },
          { type: "blockStop", index: 0 },
          stop("toolUse"),
        ]),
      );
      assert.deepEqual(message.content, [
        { type: "tool_use", id: "c1", name: "f", input: {} },
      ]);
      assert.equal(message.stop_reason, "tool_use");
    });
  }

  test("the stream path passes the same raw fragment through", async () => {
    const frames = await collect(
      emitMessagesStream(
        fromChunks([
          start,
          toolStart(0),
          { type: "toolInputDelta", index: 0, fragment: "{bad" },
          { type: "blockStop", index: 0 },
          stop("toolUse"),
        ]),
      ),
    );
    assert.ok(frames.some((frame) => frame.includes('"partial_json":"{bad"')));
  });
});
