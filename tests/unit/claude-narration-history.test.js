import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { claudeNarrationText } from "../../server/features/chat/claude-narration.js";
import { visibleReplies } from "../../web/features/chat/reply-stream.js";
import { claudeSignature } from "../helpers/claude-signature.js";

// Claude Code writes one assistant response as one record per content block, all
// sharing the message id; narration arrives as a `thinking` block whose signature
// says "narration", real thinking as an empty `thinking` block.
const fragment = (uuid, parent, block, stop = "tool_use") => ({
  type: "assistant",
  uuid,
  parentUuid: parent,
  timestamp: "2026-01-01T00:00:01.000Z",
  message: {
    id: "msg_synthetic",
    role: "assistant",
    stop_reason: stop,
    content: [block],
  },
});
const thinking = (text, kind) => ({
  type: "thinking",
  thinking: text,
  signature: claudeSignature(kind),
});
const prompt = {
  type: "user",
  uuid: "u1",
  message: { role: "user", content: "Did my reply arrive?" },
};
const turn = [
  prompt,
  fragment("a1", "u1", thinking("", "thinking")),
  fragment(
    "a2",
    "a1",
    thinking("No reply has arrived yet; enabling auto-merge.", "narration"),
  ),
  fragment("a3", "a2", {
    type: "tool_use",
    id: "tool-1",
    name: "Bash",
    input: { command: "true" },
  }),
  {
    type: "user",
    uuid: "r1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
    },
  },
  fragment("a4", "r1", {
    type: "tool_use",
    id: "tool-2",
    name: "SendMessage",
    input: {},
  }),
];

test("a narration block between tool calls is the assistant's reply", () => {
  const rows = normalizeClaude(turn).messages;
  assert.deepEqual(
    rows.map(({ role, text, toolName, narration }) => ({
      role,
      text,
      toolName,
      narration,
    })),
    [
      {
        role: "user",
        text: "Did my reply arrive?",
        toolName: undefined,
        narration: undefined,
      },
      {
        role: "assistant",
        text: "No reply has arrived yet; enabling auto-merge.",
        toolName: undefined,
        narration: true,
      },
      { role: "tool", text: rows[2].text, toolName: "Bash", narration: undefined },
      { role: "tool", text: rows[3].text, toolName: "SendMessage", narration: undefined },
    ],
  );
  assert.equal(rows[2].status, "completed");
});

test("real thinking stays hidden, also with text or a malformed signature", () => {
  const hidden = [
    thinking("Private reasoning", "thinking"),
    thinking("   ", "narration"),
    { type: "thinking", thinking: "No signature" },
    { type: "thinking", thinking: "Broken", signature: "%%%not-base64" },
    {
      type: "thinking",
      thinking: "Truncated",
      signature: claudeSignature("narration").slice(0, 8),
    },
    { type: "text", text: "Text", signature: claudeSignature("narration") },
  ];
  for (const block of hidden)
    assert.equal(claudeNarrationText(block), "", block.thinking);
  const rows = normalizeClaude([
    prompt,
    fragment("x", "u1", hidden[0], "end_turn"),
  ]).messages;
  assert.deepEqual(
    rows.map((row) => row.role),
    ["user"],
  );
});

test("narration in a user record or older text-only turns are unaffected", () => {
  const user = {
    type: "user",
    uuid: "u2",
    message: { role: "user", content: [thinking("Echo", "narration")] },
  };
  assert.deepEqual(normalizeClaude([user]).messages, []);
  const older = [
    prompt,
    fragment("t1", "u1", { type: "text", text: "Before the tool" }),
    fragment("t2", "t1", { type: "tool_use", id: "tool-9", name: "Read", input: {} }),
    fragment("t3", "t2", { type: "text", text: "After the tool" }, "end_turn"),
  ];
  assert.deepEqual(
    normalizeClaude(older).messages.map((row) => row.text.split("\n")[0]),
    ["Did my reply arrive?", "Before the tool", "{}", "After the tool"],
  );
});

test("a narration row does not hide the turn's live text draft", () => {
  const history = {
    providerSessionId: "main",
    messages: normalizeClaude(turn).messages,
  };
  // The mod streams the turn's first text block (order 0) after the narration.
  const runs = new Map([
    ["d", { runId: "d", text: "Final answer", turn: "t", order: 0 }],
  ]);
  assert.deepEqual(
    visibleReplies(runs, history).map((run) => run.runId),
    ["d"],
  );
  history.messages.push({ id: "f", role: "assistant", text: "Final answer, done" });
  assert.deepEqual(visibleReplies(runs, history), []);
});
