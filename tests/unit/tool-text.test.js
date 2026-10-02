import test from "node:test";
import assert from "node:assert/strict";
import {
  truncateToolRow,
  TOOL_TEXT_LIMIT,
  TOOL_TEXT_HEAD,
  TOOL_TEXT_TAIL,
} from "../../server/features/chat/tool-text.js";

const tool = (text) => ({
  id: "t1",
  role: "tool",
  toolName: "Bash",
  status: "completed",
  text,
});

test("short tool rows and non-tool rows are untouched", () => {
  const short = tool("x".repeat(TOOL_TEXT_LIMIT));
  assert.deepEqual(truncateToolRow(short), { row: short, full: null });
  const assistant = { id: "a", role: "assistant", text: "y".repeat(50000) };
  assert.deepEqual(truncateToolRow(assistant), { row: assistant, full: null });
});

test("long tool rows keep head, tail and metadata", () => {
  const original = "h".repeat(20000) + "é".repeat(5000) + "t".repeat(10000);
  const { row, full } = truncateToolRow(tool(original));
  assert.equal(full, original);
  assert.equal(row.text, original.slice(0, TOOL_TEXT_HEAD));
  assert.equal(row.textTail, original.slice(-TOOL_TEXT_TAIL));
  assert.deepEqual(row.truncated, {
    length: original.length,
    bytes: Buffer.byteLength(original),
  });
  assert.equal(row.id, "t1");
  assert.equal(row.toolName, "Bash");
});

test("cuts never split surrogate pairs", () => {
  const emoji = "😀";
  const original =
    "a".repeat(TOOL_TEXT_HEAD - 1) +
    emoji +
    "b".repeat(8000) +
    emoji +
    "c".repeat(TOOL_TEXT_TAIL - 1);
  const { row } = truncateToolRow(tool(original));
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.doesNotMatch(row.text, lone);
  assert.doesNotMatch(row.textTail, lone);
});
