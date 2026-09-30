import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeClaude,
  normalizeCodex,
  normalizeCodexRecords,
} from "../../server/features/chat/history-parsers.js";

test("Codex turn and rollout errors stay visible without assistant items", () => {
  const error = {
    message: "You've hit your usage limit. Try again tomorrow.",
    codex_error_info: "usage_limit_exceeded",
  };
  const turn = { id: "limited", items: [], status: "failed", error };
  const expected = [
    {
      id: "codex-turn-error:limited",
      role: "assistant",
      text: error.message,
      status: "failed",
    },
  ];
  assert.deepEqual(normalizeCodex({ turns: [turn] }).messages, expected);
  const record = {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "limited", error },
  };
  assert.deepEqual(normalizeCodexRecords([record, record]).messages, expected);
  assert.deepEqual(normalizeCodex({ turns: [{ ...turn, error: null }] }).messages, []);
});

test("Claude API failures and existing synthetic limit replies are visible; unrelated system records stay hidden", () => {
  const message = "You've hit your limit · resets 4pm";
  const records = [
    {
      uuid: "api",
      type: "system",
      subtype: "api_error",
      error: { status: 429, error: { message } },
    },
    {
      uuid: "synthetic",
      type: "assistant",
      isApiErrorMessage: true,
      error: "rate_limit",
      message: { role: "assistant", content: [{ type: "text", text: message }] },
    },
    { uuid: "hidden", type: "system", subtype: "other", error: { message: "internal" } },
    {
      uuid: "side",
      type: "system",
      subtype: "api_error",
      isSidechain: true,
      error: { message: "subagent limit" },
    },
    { uuid: "empty", type: "system", subtype: "api_error", error: { status: 429 } },
  ];
  assert.deepEqual(
    normalizeClaude(records).messages.map(({ text }) => text),
    [message, message],
  );
});
