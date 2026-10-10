import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";
const token = "123456:abcdefghijklmnopqrstuv";
test("bot validation checks identity and refuses an existing webhook without modifying it", async () => {
  const called = [];
  const client = new TelegramClient({
    token,
    fetchImpl: async (url) => {
      called.push(new URL(url).pathname.split("/").at(-1));
      return Response.json({
        ok: true,
        result:
          called.length === 1
            ? { id: 123456, is_bot: true, username: "fixture_bot" }
            : { url: "https://existing.invalid/hook" },
      });
    },
  });
  await assert.rejects(client.identity(), { code: "TELEGRAM_WEBHOOK" });
  assert.deepEqual(called, ["getMe", "getWebhookInfo"]);
});
test("transport failure hides token URLs and remote rejection preserves retry evidence", async () => {
  const client = new TelegramClient({
    token,
    fetchImpl: async () => {
      throw Error(`failed https://api.telegram.org/bot${token}/sendMessage`);
    },
  });
  await assert.rejects(
    client.call("sendMessage", { chat_id: 42, text: "Hello" }),
    (e) => e.code === "DELIVERY_UNCERTAIN" && !String(e).includes(token),
  );
  const limited = new TelegramClient({
    token,
    fetchImpl: async () =>
      Response.json(
        {
          ok: false,
          error_code: 429,
          description: token,
          parameters: { retry_after: 2 },
        },
        { status: 429 },
      ),
  });
  await assert.rejects(
    limited.call("sendMessage", {}),
    (e) =>
      e.code === "TELEGRAM_RATE_LIMIT" &&
      e.retryAfter === 2 &&
      !String(e).includes(token),
  );
});
test("receipt and typing methods use the bounded Telegram transport", async () => {
  const client = new TelegramClient({
    token,
    fetchImpl: async () => Response.json({ ok: true, result: true }),
  });
  assert.equal(
    await client.call("setMessageReaction", {
      chat_id: 42,
      message_id: 1,
      reaction: [{ type: "emoji", emoji: "👀" }],
    }),
    true,
  );
  assert.equal(
    await client.call("sendChatAction", { chat_id: 42, action: "typing" }),
    true,
  );
});
