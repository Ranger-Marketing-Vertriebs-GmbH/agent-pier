import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { visibleDeliveries } from "../../web/features/chat/chat-draft.js";
import { nativeDeliveryStates } from "../../web/features/chat/native-delivery-state.js";

const path = "/uploads/session/screenshot.png";
const timestamp = "2026-09-12T19:14:42.274Z";
const input = {
  type: "user",
  uuid: "image-user",
  promptId: "prompt",
  timestamp,
  origin: { kind: "human" },
  imagePasteIds: [17],
  message: {
    role: "user",
    content: [
      { type: "text", text: "[Image #17]" },
      { type: "image", source: { type: "base64", data: "not-exposed" } },
    ],
  },
};
const companion = {
  type: "user",
  uuid: "source",
  promptId: "prompt",
  isMeta: true,
  turnCompanion: true,
  message: { content: [{ type: "text", text: `[Image: source: ${path}]` }] },
};
const imageRecords = [input, companion];

test("Claude image source confirms one uploaded message without exposing image data or a second row", () => {
  const messages = normalizeClaude(imageRecords).messages;
  assert.deepEqual(messages, [
    { id: "image-user:0", role: "user", text: path, timestamp },
  ]);
  const item = {
    id: "delivery",
    text: path,
    baselineIds: [],
    status: "handed-off",
    observation: { generation: "g", hash: "h", startedAt: Date.parse(timestamp) - 10 },
  };
  assert.deepEqual(visibleDeliveries([item], messages), []);
  assert.equal(
    nativeDeliveryStates([item], messages, { generation: "g", queue: [] }, "claude").get(
      item.id,
    )?.state,
    "nativeAccepted",
  );
  assert.equal(
    visibleDeliveries([{ ...item, baselineIds: [messages[0].id] }], messages).length,
    1,
  );
  assert.equal(
    visibleDeliveries(
      [{ ...item, observation: { startedAt: Date.parse(timestamp) + 1 } }],
      messages,
    ).length,
    1,
  );
});

test("labels alone, foreign companions and incomplete image sets do not confirm an upload", () => {
  for (const records of [
    [input],
    [input, { ...companion, promptId: "other" }],
    [input, { ...companion, isMeta: false }],
    [{ ...input, imagePasteIds: [18] }, companion],
    [{ ...input, isSidechain: true }, companion],
    [input, companion, companion],
  ]) {
    assert.ok(
      normalizeClaude(records).messages.every((message) => message.text !== path),
    );
  }
});

test("text plus multiple images reconstructs the uploaded body in order", () => {
  const records = [
    {
      ...input,
      imagePasteIds: [17, 18],
      message: {
        content: [
          { type: "text", text: "Please compare\n[Image #17]\n[Image #18]" },
          { type: "image" },
          { type: "image" },
        ],
      },
    },
    {
      ...companion,
      message: {
        content: [
          ...companion.message.content,
          { type: "text", text: "[Image: source: /uploads/second.png]" },
        ],
      },
    },
  ];
  assert.equal(
    normalizeClaude(records).messages[0].text,
    `Please compare\n${path}\n/uploads/second.png`,
  );
});
