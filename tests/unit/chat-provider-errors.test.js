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
      notice: "usage-limit",
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

test("Codex errors without a usage-limit code carry no notice", () => {
  const error = { message: "boom", codex_error_info: "other" };
  const turn = { id: "t", items: [], status: "failed", error };
  assert.equal(normalizeCodex({ turns: [turn] }).messages[0].notice, undefined);
  const record = {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "t", error },
  };
  assert.equal(normalizeCodexRecords([record]).messages[0].notice, undefined);
});

test("Claude limit replies are marked as notices, other API errors are not", () => {
  const record = (error, extra = {}) => ({
    type: "assistant",
    uuid: "l",
    isApiErrorMessage: true,
    error,
    ...extra,
    message: {
      id: "m",
      role: "assistant",
      content: [
        {
          type: "text",
          text: "You've hit your Fable limit \u00b7 resets Nov 20 at 4pm (Europe/Berlin)",
        },
      ],
    },
  });
  const limited = normalizeClaude([record("rate_limit")]).messages;
  assert.equal(limited.length, 1);
  assert.equal(limited[0].notice, "usage-limit");
  assert.equal(normalizeClaude([record("server_error")]).messages[0].notice, undefined);
  const api = {
    uuid: "api",
    type: "system",
    subtype: "api_error",
    error: { status: 429, error: { message: "limit" } },
  };
  assert.equal(normalizeClaude([api]).messages[0].notice, "usage-limit");
  const other = { ...api, error: { status: 500, error: { message: "down" } } };
  assert.equal(normalizeClaude([other]).messages[0].notice, undefined);
});

test("billing errors and camelCase Codex codes are usage-limit notices", () => {
  const record = {
    type: "assistant",
    uuid: "b",
    isApiErrorMessage: true,
    error: "billing_error",
    message: {
      id: "m",
      role: "assistant",
      content: [{ type: "text", text: "No credit" }],
    },
  };
  assert.equal(normalizeClaude([record]).messages[0].notice, "usage-limit");
  const error = { message: "limit", codexErrorInfo: "usageLimitExceeded" };
  const turn = { id: "c", items: [], status: "failed", error };
  assert.equal(normalizeCodex({ turns: [turn] }).messages[0].notice, "usage-limit");
});
