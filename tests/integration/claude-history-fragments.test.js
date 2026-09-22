import test from "node:test";
import assert from "node:assert/strict";
import { claudeHistoryFixture } from "../helpers/claude-history.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";

const fragment = (uuid, id, block) => ({
  uuid,
  type: "assistant",
  message: { id, role: "assistant", content: [block] },
});

test("streamed Claude fragments without block ids append instead of replacing", () => {
  const { messages } = normalizeClaude([
    { uuid: "u", type: "user", message: { role: "user", content: "go" } },
    fragment("f2", "msg", { type: "text", text: "first part" }),
    fragment("f3", "msg", { type: "tool_use", id: "call", name: "Bash", input: {} }),
    fragment("f4", "msg", { type: "text", text: "second part" }),
  ]);
  assert.deepEqual(
    messages.map((message) => [message.role, message.text]),
    [
      ["user", "go"],
      ["assistant", "first part"],
      ["tool", "{}"],
      ["assistant", "second part"],
    ],
  );
});

test("provisional pages never split one message.id across interleaved results", async (t) => {
  const f = await claudeHistoryFixture(t);
  const records = [];
  for (let k = 0; k < 40; k++) {
    const id = `msg-${k}`;
    records.push(f.user(`prompt-${k}`, `prompt ${k}`));
    records.push(fragment(`${id}-a`, id, { type: "text", text: `before ${k}` }));
    for (const n of [1, 2]) {
      const call = `call-${k}-${n}`;
      records.push(
        fragment(`${id}-call-${n}`, id, {
          type: "tool_use",
          id: call,
          name: "Bash",
          input: {},
        }),
        f.user(`${id}-result-${n}`, [
          { type: "tool_result", tool_use_id: call, content: "ok" },
        ]),
      );
    }
    records.push(fragment(`${id}-b`, id, { type: "text", text: `after ${k}` }));
  }
  // Misalign page boundaries with the five rows each message produces.
  for (let i = 0; i < 3; i++) records.push(f.user(`tail-${i}`, `tail ${i}`));
  await f.write(records);
  const full = (await f.history.read(f.session, "native")).messages;
  assert.equal(full.length, 203);
  const provisional = await f.pages();
  assert.deepEqual(provisional.messages, full);
  await f.indexed();
  const indexed = await f.pages();
  assert.ok(indexed.first.next?.indexed);
  assert.deepEqual(indexed.messages, full);
});
