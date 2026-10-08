import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { inputHash } from "../../server/features/chat/native-input-queue.js";
import { deliveryContentMatches } from "../../web/features/chat/delivery-content.js";
import { nativeDeliveryStates } from "../../web/features/chat/native-delivery-state.js";
import { visibleDeliveries } from "../../web/features/chat/chat-draft.js";

// Synthetic fixtures: Claude Code records a queued image prompt as an array prompt.
const paths = [1, 2, 3, 4].map((n) => `/uploads/shot-${n}.png`);
const authored = "Compare these   layouts\nand pick one";
const sent = [authored, ...paths].join("\n");
const image = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AA==" },
};
const labelled = `[Image #5][Image #6][Image #7][Image #8] Compare these layouts\nand pick one`;
const queued = ({ text = labelled, ids = [5, 6, 7, 8], uuid = "q", at = 2000 } = {}) => ({
  type: "attachment",
  uuid: `${uuid}-attachment`,
  promptId: `${uuid}-prompt`,
  timestamp: new Date(at).toISOString(),
  attachment: {
    type: "queued_command",
    commandMode: "prompt",
    origin: { kind: "human" },
    source_uuid: uuid,
    imagePasteIds: ids,
    prompt: [{ type: "text", text }, image, image, image, image],
  },
});
const history = (...records) => normalizeClaude(records).messages;
const item = (patch = {}) => ({
  id: "delivery",
  text: sent,
  attachments: paths.map((path) => ({ key: path, name: "shot.png", path })),
  baselineIds: [],
  status: "handed-off",
  observation: {
    generation: "launch",
    startedAt: 1000,
    providerSessionId: "claude-session",
    hash: inputHash(sent),
    baseline: [],
  },
  ...patch,
});
const input = { generation: "launch", providerSessionId: "claude-session", queue: [] };
const states = (items, messages, current = input) =>
  nativeDeliveryStates(items, messages, current, "claude");

test("a queued 4-image Claude prompt confirms its delivery by text and image count", () => {
  const messages = history({ type: "queue-operation", operation: "enqueue" }, queued());
  assert.equal(deliveryContentMatches(item(), messages[0], true), true);
  assert.deepEqual(states([item()], messages).get("delivery"), {
    state: "nativeAccepted",
    messageId: "q:0",
  });
  assert.deepEqual(visibleDeliveries([item()], messages), []);
  // The row keeps the recorded labelled text, with or without a known delivery.
  assert.equal(messages[0].text, labelled);
  assert.deepEqual(
    states([item()], messages, { ...input, queue: [item().observation.hash] }).get(
      "delivery",
    ),
    { state: "nativeQueued", messageId: "q:0" },
  );
});

test("label count, label order, authored text and paths must all agree", () => {
  const unconfirmed = (messages, delivery = item()) => {
    assert.equal(states([delivery], messages).size, 0);
    assert.equal(visibleDeliveries([delivery], messages).length, 1);
  };
  unconfirmed(history(queued({ text: "[Image #5][Image #6][Image #7] Compare" })));
  unconfirmed(
    history(queued({ text: labelled.replace("#5][Image #6", "#6][Image #5") })),
  );
  unconfirmed(history(queued({ text: labelled.replace("pick one", "pick two") })));
  unconfirmed(history(queued()), item({ attachments: item().attachments.slice(0, 3) }));
  unconfirmed(
    history(queued()),
    item({ text: [authored, ...paths.slice(0, 3), "/uploads/other.png"].join("\n") }),
  );
  unconfirmed(history({ type: "queue-operation", operation: "enqueue", content: sent }));
});

test("a record before startedAt or without a start time cannot confirm", () => {
  assert.equal(states([item()], history(queued({ at: 500 }))).size, 0);
  const unstarted = item({ observation: undefined, clientCreatedAt: undefined });
  assert.equal(visibleDeliveries([unstarted], history(queued())).length, 1);
});

test("two identical pending deliveries or two candidate records stay unconfirmed", () => {
  const messages = history(queued());
  const second = item({
    id: "second",
    observation: { ...item().observation, hash: inputHash(`${sent} `) },
  });
  assert.equal(states([item(), second], messages).size, 0);
  assert.equal(visibleDeliveries([item(), second], messages).length, 2);
  const twice = history(queued(), queued({ uuid: "r", at: 2500 }));
  assert.equal(states([item()], twice).size, 0);
  assert.equal(visibleDeliveries([item()], twice).length, 1);
});

test("string-prompt queued messages still confirm by exact text", () => {
  const messages = normalizeClaude([
    {
      ...queued(),
      attachment: { ...queued().attachment, prompt: "plain text", imagePasteIds: [] },
    },
  ]).messages;
  const plain = item({
    text: "plain text",
    attachments: [],
    observation: { ...item().observation, hash: inputHash("plain text") },
  });
  assert.equal(states([plain], messages).get("delivery").state, "nativeAccepted");
});
