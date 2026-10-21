import test from "node:test";
import assert from "node:assert/strict";
import {
  longChatTokens,
  longContext,
} from "../../server/features/assistants/conversations.js";

// OpenClaw 2026.10.3 `chat.history` sessionInfo (assistant-run-steps-contract pins it).
test("a chat is long from 60 % of its window, or 100k tokens without one", () => {
  const info = (totalTokens, contextTokens, totalTokensFresh = true) => ({
    totalTokens,
    contextTokens,
    totalTokensFresh,
  });
  assert.equal(longContext(info(240000, 400000)), true);
  assert.equal(longContext(info(239999, 400000)), false);
  assert.equal(longContext(info(120000, 200000)), true);
  assert.equal(longContext(info(119999, 200000)), false);
  assert.equal(longContext(info(19700, 32768)), true);
  assert.equal(longContext(info(19600, 32768)), false);
  // Without a known window: a fixed size.
  assert.equal(longContext(info(longChatTokens, undefined)), true);
  assert.equal(longContext(info(99999, 0)), false);
  // A size that is not current (after a failed turn or a compaction) says nothing.
  assert.equal(longContext(info(150000, 400000, false)), false);
  assert.equal(longContext(undefined), false);
  assert.equal(longContext({ totalTokensFresh: true }), false);
});
