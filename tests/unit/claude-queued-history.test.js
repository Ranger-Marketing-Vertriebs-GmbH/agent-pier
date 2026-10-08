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
// Synthetic: Claude Code writes a queued message with images as an array prompt.
const image = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "AA==" },
};
const labelled = "[Image #5] [Image #6] [Image #7] [Image #8] Compare these layouts";
const queuedImages = (patch = {}) =>
  attachment({
    uuid: "queued-attachment",
    promptId: "queued-prompt",
    attachment: {
      ...attachment().attachment,
      source_uuid: "queued-source",
      imagePasteIds: [5, 6, 7, 8],
      prompt: [{ type: "text", text: labelled }, image, image, image, image],
      ...patch,
    },
  });
test("a queued human prompt with images becomes a visible user message with image evidence", () => {
  const enqueue = { type: "queue-operation", operation: "enqueue", content: labelled };
  assert.deepEqual(normalizeClaude([enqueue, queuedImages()]).messages, [
    {
      id: "queued-source:0",
      role: "user",
      text: labelled,
      timestamp: "2026-09-12T06:21:51.917Z",
      claudeImageInput: { text: "Compare these layouts", count: 4 },
    },
  ]);
  assert.deepEqual(normalizeClaude([enqueue]).messages, []);
  // Queued attachments need not carry a promptId.
  const { promptId: _promptId, ...unprompted } = queuedImages();
  assert.deepEqual(normalizeClaude([unprompted]).messages[0].claudeImageInput, {
    text: "Compare these layouts",
    count: 4,
  });
});
test("source paths of an earlier prompt never attach to a queued image prompt", () => {
  const source = (n) => ({
    type: "user",
    uuid: `source-${n}`,
    promptId: "queued-prompt",
    isMeta: true,
    turnCompanion: true,
    message: { content: [{ type: "text", text: `[Image: source: /old/${n}.png]` }] },
  });
  const [message] = normalizeClaude([
    source(1),
    source(2),
    source(3),
    source(4),
    queuedImages(),
  ]).messages;
  assert.equal(message.text, labelled);
  assert.doesNotMatch(message.text, /\/old\//);
  assert.deepEqual(message.claudeImageInput, { text: "Compare these layouts", count: 4 });
});
test("queued image prompts only carry evidence when labels, ids and images agree", () => {
  const evidence = (patch) =>
    normalizeClaude([queuedImages(patch)]).messages[0]?.claudeImageInput;
  const text = (value) => ({
    prompt: [{ type: "text", text: value }, image, image, image, image],
  });
  assert.equal(evidence(text("[Image #5] [Image #6] [Image #7] Compare")), undefined);
  assert.equal(
    evidence(text("[Image #6] [Image #5] [Image #7] [Image #8] x")),
    undefined,
  );
  assert.equal(evidence({ imagePasteIds: [5, 6, 7] }), undefined);
  assert.equal(evidence({ imagePasteIds: undefined }), undefined);
  assert.equal(
    evidence({ prompt: [{ type: "text", text: labelled }, image, image, image] }),
    undefined,
  );
  // Other block types, empty arrays and non-human input never become messages.
  for (const patch of [
    { prompt: [{ type: "text", text: labelled }, { type: "tool_result" }] },
    { prompt: [] },
    { prompt: [{ type: "text", text: 5 }] },
    { origin: { kind: "agent" } },
  ])
    assert.deepEqual(normalizeClaude([queuedImages(patch)]).messages, []);
});
test("pasted text inside an array prompt is unwrapped", () => {
  const wrapped =
    '\n\n<pasted_content id="ab12">\nFirst\nSecond\n</pasted_content id="ab12">\n';
  const [message] = normalizeClaude([
    queuedImages({
      imagePasteIds: [5],
      prompt: [{ type: "text", text: `[Image #5]${wrapped}` }, image],
    }),
  ]).messages;
  assert.equal(message.text, "[Image #5]\nFirst\nSecond");
  assert.deepEqual(message.claudeImageInput, { text: "First\nSecond", count: 1 });
});
