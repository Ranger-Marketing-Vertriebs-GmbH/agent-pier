import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";
import {
  sendTelegramFile,
  telegramFileMethod,
} from "../../server/features/assistant-channels/telegram-file.js";

const token = "123456:abcdefghijklmnopqrstuv";
const MB = 1024 * 1024;
const file = (type, size, inline = true) => ({
  name: "f",
  type,
  inline,
  body: Buffer.alloc(size),
});

test("uploads are multipart and limited to sendPhoto and sendDocument", async () => {
  const requests = [];
  const client = new TelegramClient({
    token,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return Response.json({ ok: true, result: { message_id: 7, chat: { id: 42 } } });
    },
  });
  await client.upload(
    "sendPhoto",
    { chat_id: "42", caption: "Look" },
    { name: "chart.png", type: "image/png", body: Buffer.from("png") },
  );
  const [{ url, init }] = requests;
  assert.match(url, /\/sendPhoto$/);
  assert.ok(init.body instanceof FormData);
  assert.equal(init.headers, undefined);
  assert.equal(init.redirect, "error");
  assert.equal(init.body.get("chat_id"), "42");
  assert.equal(init.body.get("caption"), "Look");
  const photo = init.body.get("photo");
  assert.equal(photo.name, "chart.png");
  assert.equal(Buffer.from(await photo.arrayBuffer()).toString(), "png");
  for (const method of ["sendMessage", "sendAudio", "setWebhook", "__proto__"])
    await assert.rejects(
      client.upload(method, {}, { name: "x", type: "x", body: Buffer.from("x") }),
      { code: "TELEGRAM_METHOD" },
    );
  // Telegram's own size limits are never exceeded.
  await assert.rejects(client.upload("sendPhoto", {}, file("image/png", 10 * MB + 1)), {
    code: "TELEGRAM_METHOD",
  });
  // The JSON transport still refuses the upload methods.
  await assert.rejects(client.call("sendDocument", {}), { code: "TELEGRAM_METHOD" });
  assert.equal(requests.length, 1);
});

test("a lost upload answer leaves the delivery uncertain, a refusal says so", async () => {
  const lost = new TelegramClient({
    token,
    fetchImpl: async () => {
      throw Error("reset");
    },
  });
  await assert.rejects(lost.upload("sendDocument", {}, file("text/csv", 1)), {
    code: "DELIVERY_UNCERTAIN",
  });
  const refused = new TelegramClient({
    token,
    fetchImpl: async () => Response.json({ ok: false, error_code: 400 }, { status: 400 }),
  });
  await assert.rejects(refused.upload("sendPhoto", {}, file("image/png", 1)), {
    code: "TELEGRAM_REJECTED",
    badRequest: true,
  });
});

test("photos are JPEG, PNG or WebP within 10 MB; everything else is a document", () => {
  assert.equal(telegramFileMethod(file("image/png", 10)), "sendPhoto");
  assert.equal(telegramFileMethod(file("image/jpeg", 10 * MB)), "sendPhoto");
  assert.equal(telegramFileMethod(file("image/webp", 10)), "sendPhoto");
  assert.equal(telegramFileMethod(file("image/jpeg", 10 * MB + 1)), "sendDocument");
  assert.equal(telegramFileMethod(file("image/gif", 10)), "sendDocument");
  assert.equal(telegramFileMethod(file("image/heic", 10)), "sendDocument");
  // Bytes that no longer prove the image are never sent as a photo.
  assert.equal(telegramFileMethod(file("image/png", 10, false)), "sendDocument");
  assert.equal(telegramFileMethod(file("application/pdf", 10)), "sendDocument");
  assert.equal(telegramFileMethod(file("image/png", 10), true), "sendDocument");
  assert.equal(telegramFileMethod(file("application/zip", 50 * MB + 1)), null);
});

test("a file notice sends its caption, clipped to Telegram's 1024 characters", async () => {
  const calls = [];
  let entry = {
    state: "outbound",
    nextDeliveryAt: 0,
    chatId: "42",
    text: "x".repeat(1030),
  };
  await sendTelegramFile({
    client: {
      upload: async (method, params, upload) => {
        calls.push({ method, params, upload });
        return { message_id: 9, chat: { id: 42 } };
      },
    },
    entry,
    file: { ...file("application/pdf", 3), name: "report.pdf" },
    signal: new AbortController().signal,
    save: (patch) => (entry = { ...entry, ...patch }),
    changed() {},
  });
  assert.equal(calls[0].method, "sendDocument");
  assert.equal(calls[0].params.caption.length, 1024);
  assert.equal(calls[0].upload.name, "report.pdf");
  assert.deepEqual([entry.state, entry.remoteMessageIds], ["delivered", [9]]);
});
