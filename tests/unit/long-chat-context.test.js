import test from "node:test";
import assert from "node:assert/strict";
import {
  longChatTokens,
  longContext,
} from "../../server/features/assistants/conversations.js";

// OpenClaw 2026.10.3 `chat.history` sessionInfo (assistant-run-steps-contract pins it).
test("a chat is long from 100k context tokens, or 80 % of a smaller window", () => {
  const info = (totalTokens, contextTokens, totalTokensFresh = true) => ({
    totalTokens,
    contextTokens,
    totalTokensFresh,
  });
  assert.equal(longContext(info(longChatTokens, 400000)), true);
  assert.equal(longContext(info(147000, 400000)), true);
  assert.equal(longContext(info(99999, 400000)), false);
  assert.equal(longContext(info(26300, 32768)), true);
  assert.equal(longContext(info(20000, 32768)), false);
  assert.equal(longContext(info(150000, undefined)), true);
  // A size that is not current (after a failed turn or a compaction) says nothing.
  assert.equal(longContext(info(150000, 400000, false)), false);
  assert.equal(longContext(undefined), false);
  assert.equal(longContext({ totalTokensFresh: true }), false);
});
