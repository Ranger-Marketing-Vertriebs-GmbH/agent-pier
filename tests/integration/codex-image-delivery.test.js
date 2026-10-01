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

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jzN8AAAAASUVORK5CYII=",
  "base64",
);
const other = Buffer.concat([png, Buffer.from("different image")]);
const nativeInput = { generation: "launch", providerSessionId: "thread", queue: [] };
function snapshot(text, images = [png], camel = false) {
  let prefix = "";
  const elements = images.map((_, i) => {
    const placeholder = `[Image #${i + 1}]`;
    const start = prefix.length;
    prefix += `${placeholder} `;
    return {
      [camel ? "byteRange" : "byte_range"]: { start, end: start + placeholder.length },
      placeholder,
    };
  });
  return normalizeCodex({
    turns: [
      {
        items: [
          {
            type: "userMessage",
            id: "native-user",
            timestamp: 1001,
            content: [
              ...images.map((bytes) => ({
                type: "image",
                [camel ? "imageUrl" : "image_url"]:
                  `data:image/png;base64,${bytes.toString("base64")}`,
              })),
              {
                type: "text",
                text: prefix + text,
                [camel ? "textElements" : "text_elements"]: elements,
              },
            ],
          },
        ],
      },
    ],
  });
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-image-delivery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "uploads");
  await fs.mkdir(directory);
  const first = path.join(directory, "first.png");
  const second = path.join(directory, "second.png");
  await fs.writeFile(first, png);
  await fs.writeFile(second, other);
  const session = { id: "session", tool: "codex", cwd: root, attachments: { directory } };
  const sessions = { get: async () => session };
  const attachments = new ChatAttachments({ dataDir: root, sessions });
  const images = new ChatImages({ sessions, attachments });
  const decorate = async (data) => (await images.decorate("session", data)).messages;
  const delivery = (text = "What is wrong?", paths = [first]) => ({
    id: "delivery",
    scope: '["session","account","codex",null]',
    text: [text, ...paths].filter(Boolean).join("\n"),
    attachments: paths.map((file) => ({
      key: file,
      name: path.basename(file),
      path: file,
    })),
    baselineIds: [],
    status: "handed-off",
    clientCreatedAt: new Date(1000).toISOString(),
    observation: { ...nativeInput, startedAt: 1000, hash: "body-hash", baseline: [] },
  });
  return { root, directory, first, second, session, attachments, decorate, delivery };
}

test("Codex image history reconciles an existing upload and native acceptance without exposing image data", async (t) => {
  const f = await fixture(t);
  for (const camel of [false, true]) {
    const raw = snapshot("What is wrong?", [png], camel);
    assert.ok(!JSON.stringify(raw).includes(png.toString("base64")));
    const messages = await f.decorate(raw);
    const item = f.delivery(); // Old drafts need no new hash or receipt fields.
    assert.deepEqual(visibleDeliveries([item], messages), []);
    assert.equal(
      nativeDeliveryStates([item], messages, nativeInput, "codex").get(item.id)?.state,
      "nativeAccepted",
    );
    assert.equal(messages[0].text, "[Image #1] What is wrong?");
    assert.equal(item.status, "handed-off");
  }
});

test("uploads in legacy sessions without a launch grant also reconcile", async (t) => {
  const f = await fixture(t);
  delete f.session.attachments;
  f.session.status = "running";
  const upload = await f.attachments.save("session", "legacy.png", png);
  const messages = await f.decorate(snapshot("What is wrong?"));
  assert.deepEqual(
    visibleDeliveries([f.delivery("What is wrong?", [upload.path])], messages),
    [],
  );
});

test("image-only, multiple images and literal image labels preserve authored content and order", async (t) => {
  const f = await fixture(t);
  for (const text of ["", "  Größe prüfen\n[Image #99] is literal", "Compare"]) {
    const messages = await f.decorate(snapshot(text, [png, other]));
    const item = f.delivery(text, [f.first, f.second]);
    assert.deepEqual(visibleDeliveries([item], messages), []);
    assert.equal(
      nativeDeliveryStates([item], messages, nativeInput, "codex").get(item.id)?.state,
      "nativeAccepted",
    );
    assert.equal(
      visibleDeliveries([f.delivery(text, [f.second, f.first])], messages).length,
      1,
    );
  }
});

test("same text with different images, missing chip evidence and old native rows remain distinct", async (t) => {
  const f = await fixture(t);
  const messages = await f.decorate(snapshot("What is wrong?"));
  const item = f.delivery();
  for (const candidate of [
    f.delivery("What is wrong?", [f.second]),
    f.delivery("Different text"),
    { ...item, baselineIds: [messages[0].id] },
    { ...item, observation: { ...item.observation, startedAt: 1002 } },
  ])
    assert.equal(visibleDeliveries([candidate], messages).length, 1);
  const unknown = snapshot("What is wrong?");
  delete unknown.messages[0].imageInput;
  assert.equal(visibleDeliveries([item], await f.decorate(unknown)).length, 1);
  for (const input of [
    { ...nativeInput, generation: "other" },
    { ...nativeInput, providerSessionId: "other" },
    { ...nativeInput, queue: ["body-hash", "body-hash"] },
  ])
    assert.equal(nativeDeliveryStates([item], messages, input, "codex").size, 0);
  assert.equal(visibleDeliveries([item, { ...item, id: "second" }], messages).length, 1);
});

test("identical reuploads match their own paths, changed or foreign files cannot supply evidence", async (t) => {
  const f = await fixture(t);
  const nested = path.join(f.directory, "file-upload");
  await fs.mkdir(nested);
  const duplicate = path.join(nested, "same.png");
  await fs.writeFile(duplicate, png);
  let messages = await f.decorate(snapshot("What is wrong?"));
  assert.deepEqual(
    visibleDeliveries([f.delivery("What is wrong?", [duplicate])], messages),
    [],
  );
  const original = f.delivery();
  const reupload = {
    ...f.delivery("What is wrong?", [duplicate]),
    id: "reupload",
    observation: { ...original.observation, hash: "different-path-body" },
  };
  assert.equal(visibleDeliveries([original, reupload], messages).length, 1);
  assert.equal(
    nativeDeliveryStates([original, reupload], messages, nativeInput, "codex").size,
    0,
  );
  assert.equal(
    nativeDeliveryStates(
      [{ ...original, matchedMessageId: "older-native-user" }, reupload],
      messages,
      nativeInput,
      "codex",
    ).get(reupload.id)?.state,
    "nativeAccepted",
  );
  await fs.writeFile(f.first, other);
  messages = await f.decorate(snapshot("What is wrong?"));
  assert.equal(visibleDeliveries([f.delivery()], messages).length, 1);
  await fs.rm(f.first);
  await fs.symlink(duplicate, f.first);
  assert.equal(
    visibleDeliveries([f.delivery()], await f.decorate(snapshot("What is wrong?")))
      .length,
    1,
  );
  f.session.attachments.directory = path.join(f.root, "foreign");
  await fs.mkdir(f.session.attachments.directory);
  assert.equal(
    visibleDeliveries(
      [f.delivery("What is wrong?", [duplicate])],
      await f.decorate(snapshot("What is wrong?")),
    ).length,
    1,
  );
});
