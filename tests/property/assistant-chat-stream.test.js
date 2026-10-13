import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { check } from "../helpers/property.js";
import { ChatStreams } from "../../server/features/assistants/chat-stream.js";

// The Gateway sends the reply as a snapshot, appended pieces and, where the text was
// rewritten, a replace frame (`takeBufferDelta`). Any such split adds up to the text.
test("any snapshot, append and replace split reproduces the streamed text", () => {
  const piece = fc.record({
    text: fc.string({ maxLength: 12 }),
    replace: fc.boolean(),
  });
  check(
    fc.property(
      fc.string({ maxLength: 12 }),
      fc.array(piece, { maxLength: 12 }),
      (first, pieces) => {
        const streams = new ChatStreams();
        let expected = first;
        let seen = streams.delta({
          runId: "r",
          sessionKey: "s",
          deltaText: first,
          message: { role: "assistant", content: [{ type: "text", text: first }] },
        });
        assert.equal(seen, expected);
        for (const { text, replace } of pieces) {
          expected = replace ? text : expected + text;
          seen = streams.delta({
            runId: "r",
            sessionKey: "s",
            deltaText: text,
            ...(replace ? { replace: true } : {}),
          });
          assert.equal(seen, expected);
        }
      },
    ),
  );
});
