import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { png, shareFixture, token } from "../helpers/agent-share-fixture.js";
import { generatedImageRefs } from "../../server/features/assistants/generated-images.js";

const task = "44e94c4f-bb9c-4e50-af0b-65f203e10a6e";
const artifactId = "artifact_managed_image_ecfbf9d6-7803-4f03-aba7-70598bd85b98";
// The messages OpenClaw 2026.10.3 writes for an image_generate turn and its
// background completion (recorded with the pinned runtime, see the live contract).
function imageTurn(attemptId, at, { id = artifactId } = {}) {
  return [
    {
      role: "user",
      content: "Draw a grey square",
      timestamp: at,
      idempotencyKey: `${attemptId}:user`,
      __openclaw: { id: "u1" },
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "image_generate", arguments: {} }],
      timestamp: at + 1,
      __openclaw: { id: "a1", runId: attemptId },
    },
    {
      role: "toolResult",
      toolName: "image_generate",
      content: [
        {
          type: "text",
          text: `Background task started for image generation (tool:image_generate:${task}).`,
        },
      ],
      timestamp: at + 2,
      __openclaw: { id: "r1", runId: attemptId },
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "It is on its way." }],
      timestamp: at + 3,
      __openclaw: { id: "a2", runId: attemptId },
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Here is the picture." },
        {
          type: "image",
          artifactId: id,
          url: "/api/chat/media/outgoing/x/y/full",
          alt: "image-1.png",
          mimeType: "image/png",
          sizeBytes: png.length,
        },
      ],
      timestamp: at + 4,
      __openclaw: {
        id: "a3",
        runId: `image_generate:tool:image_generate:${task}:ok:agent-loop`,
      },
    },
  ];
}

async function setup(
  t,
  { body = png, url = "/api/chat/media/outgoing/s/i/full?t=1" } = {},
) {
  const f = await shareFixture(t);
  const client = f.service.runtime.client;
  const base = client.call;
  const calls = [];
  client.call = async (method, params) => {
    if (method === "artifacts.download") {
      calls.push(params);
      return { artifact: { id: params.artifactId }, url };
    }
    return base(method, params);
  };
  client.download = async (path, { maxBytes }) => {
    assert.equal(path, url);
    assert.ok(maxBytes >= png.length);
    return { body, type: "image/png" };
  };
  return { ...f, calls };
}
const shared = async (f) =>
  (await f.service.history(f.chat.id)).messages.filter((m) => m.shared);
async function until(check) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  assert.fail("timed out");
}

test("the images an image_generate completion leaves are found in raw history", () => {
  const refs = generatedImageRefs(imageTurn("attempt-1", 1000));
  assert.deepEqual(refs, [{ artifactId, name: "image-1.png", timestamp: 1004, task }]);
  // Only managed image artifacts count; other blocks and user messages never do.
  assert.deepEqual(
    generatedImageRefs([
      { role: "user", content: [{ type: "image", artifactId }] },
      { role: "assistant", content: [{ type: "image", artifactId: "../x" }] },
    ]),
    [],
  );
});

test("a generated image of a Telegram turn reaches the chat once and the paired chat", async (t) => {
  const f = await setup(t);
  const attempt = await f.turn(f.chat, "draw", {
    kind: "telegram",
    channelId: f.channel.id,
    chatId: f.channel.chatId,
    userId: f.channel.userId,
    inputId: "input-1",
  });
  const at = Date.now() - 5000;
  f.setHistory(imageTurn(attempt.id, at));
  const [image] = await until(async () => {
    const found = await shared(f);
    return found.length ? found : null;
  });
  assert.equal(image.role, "assistant");
  assert.deepEqual(
    image.attachments.map((x) => [x.name, x.type, x.kind]),
    [["image-1.png", "image/png", "image"]],
  );
  // Shown where the completion was written, after its words.
  assert.equal(image.timestamp, at + 4);
  const content = await f.service.attachments.content(image.attachments[0].id);
  assert.deepEqual(content.body, png);
  assert.equal(content.inline, true);
  // Read again, nothing is copied twice.
  await f.service.history(f.chat.id);
  await f.service.generatedImages.observe(f.chat);
  await delay(50);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { sessionKey: f.chat.runtimeSessionKey, artifactId });
  assert.equal((await shared(f)).length, 1);
  await f.deliver();
  const [upload] = f.api.files(token, 42);
  assert.equal(upload.method, "sendPhoto");
  assert.deepEqual(upload.params.photo.bytes, png);
  assert.equal(f.audit.at(-1).details.kind, "generated-image");
  assert.equal(f.audit.at(-1).details.channel, "telegram");
});

test("an owner's web turn gets the image in the chat only", async (t) => {
  const f = await setup(t);
  const attempt = await f.turn(f.chat, "draw-web");
  f.setHistory(imageTurn(attempt.id, Date.now() - 5000));
  await f.service.generatedImages.observe(f.chat);
  assert.equal((await shared(f)).length, 1);
  await f.deliver();
  assert.deepEqual(f.api.files(token, 42), []);
});

test("bytes that are no image, or a location off the Gateway's media path, are refused", async (t) => {
  const notImage = await setup(t, { body: Buffer.from("<svg onload=alert(1)>") });
  const attempt = await notImage.turn(notImage.chat, "draw-bad");
  notImage.setHistory(imageTurn(attempt.id, Date.now() - 5000));
  await notImage.service.generatedImages.observe(notImage.chat);
  assert.deepEqual(await shared(notImage), []);
  // A failed copy waits before the next try instead of downloading on every read.
  await notImage.service.generatedImages.observe(notImage.chat);
  assert.equal(notImage.calls.length, 1);

  const elsewhere = await setup(t, { url: "/api/other/thing" });
  const second = await elsewhere.turn(elsewhere.chat, "draw-elsewhere");
  elsewhere.setHistory(imageTurn(second.id, Date.now() - 5000));
  await elsewhere.service.generatedImages.observe(elsewhere.chat);
  assert.deepEqual(await shared(elsewhere), []);
});

test("nothing is copied while AgentPier is in maintenance", async (t) => {
  const f = await setup(t);
  const attempt = await f.turn(f.chat, "draw-maintenance");
  f.setHistory(imageTurn(attempt.id, Date.now() - 5000));
  f.service.maintenance = true;
  await f.service.generatedImages.observe(f.chat);
  assert.equal(f.calls.length, 0);
  f.service.maintenance = false;
  await f.service.generatedImages.observe(f.chat);
  assert.equal(f.calls.length, 1);
});
