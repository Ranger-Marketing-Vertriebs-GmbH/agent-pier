import test from "node:test";
import assert from "node:assert/strict";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import {
  deliveryMatches,
  visibleDeliveries,
} from "../../web/features/chat/chat-draft.js";
import { deliveryContentMatches } from "../../web/features/chat/delivery-content.js";

// Synthetic text in the shape Claude Code 2.1.288 writes for bracketed pastes.
const wrap = (text, id = "e8ae") =>
  `\n\n<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">\n`;
const now = Date.parse("2026-10-03T08:00:00.000Z");
const item = (text) => ({
  id: "delivery",
  text,
  baselineIds: [],
  clientCreatedAt: new Date(now).toISOString(),
});
const row = (text) => ({ role: "user", id: "m", timestamp: now + 1, text });

test("a pasted multi-line message matches its delivery without the paste wrapper", () => {
  const delivery = item("a\nb\nc");
  const message = row(wrap("a\nb\nc"));
  assert.equal(deliveryMatches([delivery], [message]).get("delivery"), "m");
  assert.deepEqual(visibleDeliveries([delivery], [message]), []);
  assert.equal(deliveryContentMatches(delivery, message, true), true);
});

test("an unwrapped two-line message still matches as before", () => {
  const delivery = item("a\nb");
  const message = row("a\nb");
  assert.equal(deliveryMatches([delivery], [message]).get("delivery"), "m");
  assert.equal(deliveryContentMatches(delivery, message, true), true);
});

test("text that only mentions the paste tag or uses mismatched ids stays untouched", () => {
  const mention = 'Explain <pasted_content id="e8ae"> please';
  assert.equal(deliveryContentMatches(item("Explain"), row(mention)), false);
  assert.equal(deliveryContentMatches(item(mention), row(mention), true), true);
  const mismatched =
    '\n\n<pasted_content id="e8ae">\na\nb\nc\n</pasted_content id="0874">\n';
  assert.equal(deliveryContentMatches(item("a\nb\nc"), row(mismatched)), false);
  const unbounded = wrap("a\nb\nc", "not-hex");
  assert.equal(deliveryContentMatches(item("a\nb\nc"), row(unbounded)), false);
});

test("several pasted segments and a paste after typed text are unwrapped in place", () => {
  const twice = `${wrap("one\ntwo\nthree")}${wrap("four\nfive\nsix", "0874")}`;
  assert.equal(
    deliveryContentMatches(item("one\ntwo\nthree\nfour\nfive\nsix"), row(twice), true),
    true,
  );
  const typed = `Look at this:${wrap("x\ny\nz")}`;
  assert.equal(deliveryContentMatches(item("Look at this:\nx\ny\nz"), row(typed)), true);
});

test("Claude history strips the paste wrapper from strings, text blocks and queued prompts", () => {
  const text = "first line\nsecond line\nthird line";
  const records = [
    { type: "user", uuid: "string", message: { role: "user", content: wrap(text) } },
    {
      type: "user",
      uuid: "blocks",
      message: { role: "user", content: [{ type: "text", text: wrap(text, "0874") }] },
    },
    {
      type: "attachment",
      uuid: "attachment",
      attachment: {
        type: "queued_command",
        prompt: wrap(text, "1a2b"),
        source_uuid: "queued",
        commandMode: "prompt",
        origin: { kind: "human" },
      },
    },
    {
      type: "assistant",
      uuid: "reply",
      message: { id: "reply", role: "assistant", content: wrap(text) },
    },
  ];
  assert.deepEqual(
    normalizeClaude(records).messages.map((m) => [m.id, m.text]),
    [
      ["string", text],
      ["blocks:0", text],
      ["queued", text],
      ["reply", wrap(text)],
    ],
  );
  const mention = 'The tag <pasted_content id="e8ae"> is literal';
  assert.equal(
    normalizeClaude([{ type: "user", uuid: "u", message: { content: mention } }])
      .messages[0].text,
    mention,
  );
});
