import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeCodex } from "../../server/features/chat/history-parsers.js";
import { ChatImages } from "../../server/features/chat/chat-images.js";
import { ChatAttachments } from "../../server/features/chat/chat-attachments.js";
import { visibleDeliveries } from "../../web/features/chat/chat-draft.js";
import { nativeDeliveryStates } from "../../web/features/chat/native-delivery-state.js";

// Codex 0.169.1's own history rows and receipts for messages AgentPier delivered,
// recorded through its delivery path (see the note in the fixture).
const recorded = JSON.parse(
  await fs.readFile(
    new URL("../fixtures/chat-delivery/codex-user-messages.json", import.meta.url),
    "utf8",
  ),
);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);
const nativeInput = { generation: "launch", providerSessionId: "thread", queue: [] };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-recorded-delivery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "uploads");
  await fs.mkdir(directory);
  const uploads = {};
  for (const [name, bytes] of [
    ["shot.png", png],
    ["notes.txt", Buffer.from("hello file\n")],
  ]) {
    await fs.mkdir(path.join(directory, name.replace(".", "-")));
    uploads[name] = path.join(directory, name.replace(".", "-"), name);
    await fs.writeFile(uploads[name], bytes);
  }
  const session = { id: "session", tool: "codex", cwd: root, attachments: { directory } };
  const sessions = { get: async () => session };
  const images = new ChatImages({
    sessions,
    attachments: new ChatAttachments({ dataDir: root, sessions }),
  });
  const fill = (value) =>
    JSON.parse(
      JSON.stringify(value)
        .replaceAll("<image>", `data:image/png;base64,${png.toString("base64")}`)
        .replace(/<upload:([^>]+)>/g, (_, name) => uploads[name]),
    );
  const messages = async (message) =>
    (
      await images.decorate(
        "session",
        normalizeCodex({ turns: [{ items: [fill(message.item)] }] }),
      )
    ).messages;
  const delivery = (message) => ({
    id: message.label,
    scope: '["session","account","codex",null]',
    text: fill(message.body),
    attachments: message.attachments.map((name) => ({
      key: name,
      name,
      path: uploads[name],
    })),
    baselineIds: [],
    ...message.receipt,
    clientCreatedAt: new Date(0).toISOString(),
    observation: { ...nativeInput, startedAt: 0, hash: message.label, baseline: [] },
  });
  return { messages, delivery, uploads };
}

const byLabel = (label) => recorded.messages.find((message) => message.label === label);

test("a recorded Codex image row with a text file path retires its card and shows the badge", async (t) => {
  const f = await fixture(t);
  for (const label of ["image and text file", "image"]) {
    const message = byLabel(label);
    const messages = await f.messages(message);
    const item = f.delivery(message);
    assert.deepEqual(visibleDeliveries([item], messages), [], label);
    assert.deepEqual(
      nativeDeliveryStates([item], messages, nativeInput, "codex").get(item.id),
      { state: "nativeAccepted", messageId: messages[0].id },
      label,
    );
  }
});

test("an image row matches only the same text, file lines and images", async (t) => {
  const f = await fixture(t);
  const message = byLabel("image and text file");
  const messages = await f.messages(message);
  const item = f.delivery(message);
  const notes = f.uploads["notes.txt"];
  const shot = f.uploads["shot.png"];
  for (const candidate of [
    // The file line is part of the text Codex received.
    {
      ...item,
      text: item.text.replace(`\n${notes}`, ""),
      attachments: [item.attachments[0]],
    },
    // Other words.
    { ...item, text: item.text.replace("look at both", "look at one") },
    // Without the image there is no chip to match.
    {
      ...item,
      text: item.text.replace(`\n${shot}`, ""),
      attachments: [item.attachments[1]],
    },
  ])
    assert.equal(visibleDeliveries([candidate], messages).length, 1);
});
