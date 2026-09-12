import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { visibleDeliveries } from "../../web/features/chat/chat-draft.js";
const prompt = "Use the staging environment\nThen continue";
const attachment = (overrides = {}) => ({
  type: "attachment",
  uuid: "attachment-id",
  timestamp: "2026-09-12T06:21:51.917Z",
  attachment: {
    type: "queued_command",
    prompt,
    source_uuid: "source-id",
    commandMode: "prompt",
    origin: { kind: "human" },
  },
  rendered: [{ content: "INTERNAL REMINDER MUST STAY HIDDEN" }],
  ...overrides,
});
test("absorbed human input becomes one stable user message and clears its handoff notice", () => {
  const records = [
    { type: "queue-operation", operation: "enqueue", content: prompt },
    {
      type: "queue-operation",
      operation: "remove",
      reason: "absorbed_mid_turn",
      content: prompt,
    },
    attachment(),
    attachment(),
  ];
  const messages = normalizeClaude(records).messages;
  assert.deepEqual(messages, [
    {
      id: "source-id",
      role: "user",
      text: prompt,
      timestamp: "2026-09-12T06:21:51.917Z",
    },
  ]);
  const delivery = { id: "delivery", text: prompt, baselineIds: [] };
  assert.deepEqual(visibleDeliveries([delivery], messages), []);
  assert.equal(
    visibleDeliveries([delivery, { ...delivery, id: "second" }], messages).length,
    1,
  );
  assert.equal(
    visibleDeliveries([{ ...delivery, baselineIds: ["source-id"] }], messages).length,
    1,
  );
  assert.deepEqual(
    normalizeClaude([
      ...records,
      { type: "user", uuid: "source-id", message: { content: prompt } },
    ]).messages.map((m) => m.id),
    ["source-id"],
  );
});
test("queue changes and non-human or malformed attachments cannot confirm delivery", () => {
  const queued = attachment().attachment;
  const records = [
    { type: "queue-operation", operation: "enqueue", content: prompt },
    {
      type: "queue-operation",
      operation: "remove",
      reason: "absorbed_mid_turn",
      content: prompt,
    },
    attachment({ isMeta: true }),
    attachment({ isCompactSummary: true }),
    attachment({ isSidechain: true }),
    ...[
      { origin: { kind: "agent" } },
      { origin: undefined },
      { commandMode: "bash" },
      { type: "file" },
      { source_uuid: "" },
      { prompt: { text: prompt } },
    ].map((patch) => attachment({ attachment: { ...queued, ...patch } })),
  ];
  assert.deepEqual(normalizeClaude(records).messages, []);
});
