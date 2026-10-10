export const channelError = (code, status = 503, extra = {}) =>
  Object.assign(new Error(code), { code, status, ...extra });
export async function boundedBytes(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw channelError("MEDIA_TOO_LARGE", 400);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw channelError("MEDIA_TOO_LARGE", 400);
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export class TelegramClient {
  constructor({ token, fetchImpl = fetch }) {
    if (typeof token !== "string" || !/^\d+:[a-zA-Z0-9_-]{20,200}$/.test(token))
      throw channelError("TELEGRAM_TOKEN", 400);
    Object.assign(this, { token, fetchImpl });
  }
  async call(method, params = {}, signal) {
    if (
      ![
        "getMe",
        "getWebhookInfo",
        "getUpdates",
        "getFile",
        "sendMessage",
        "answerCallbackQuery",
        "setMessageReaction",
        "sendChatAction",
      ].includes(method)
    )
      throw channelError("TELEGRAM_METHOD", 400);
    const combined = AbortSignal.any([
      AbortSignal.timeout(method === "getUpdates" ? 35000 : 20000),
      ...(signal ? [signal] : []),
    ]);
    let response, data;
    try {
      response = await this.fetchImpl(
        `https://api.telegram.org/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal: combined,
          redirect: "error",
        },
      );
      data = JSON.parse((await boundedBytes(response, 2 * 1024 * 1024)).toString());
    } catch {
      throw channelError(
        method === "sendMessage" ? "DELIVERY_UNCERTAIN" : "TELEGRAM_UNAVAILABLE",
      );
    }
    if (!response.ok || data.ok !== true) {
      const code = data.error_code;
      if (code === 429)
        throw channelError("TELEGRAM_RATE_LIMIT", 429, {
          retryAfter: Math.max(
            1,
            Math.min(Number(data.parameters?.retry_after) || 30, 3600),
          ),
        });
      if (code === 409) throw channelError("TELEGRAM_CONFLICT", 409);
      if ([400, 401, 403, 404].includes(code))
        throw channelError("TELEGRAM_REJECTED", 400, {
          rejected: true,
          // A bad request (malformed markup, an unacceptable link target, ...)
          // proves Telegram did not accept the message.
          badRequest: code === 400,
        });
      throw channelError(
        method === "sendMessage" ? "DELIVERY_UNCERTAIN" : "TELEGRAM_UNAVAILABLE",
      );
    }
    return data.result;
  }
  async identity(signal) {
    const me = await this.call("getMe", {}, signal);
    if (
      !me?.is_bot ||
      !Number.isSafeInteger(me.id) ||
      !/^[a-zA-Z0-9_]{5,32}$/.test(me.username)
    )
      throw channelError("TELEGRAM_IDENTITY", 400);
    const webhook = await this.call("getWebhookInfo", {}, signal);
    if (webhook.url) throw channelError("TELEGRAM_WEBHOOK", 409);
    return { id: me.id, username: me.username };
  }
  async audio(fileId, signal, limit = 10 * 1024 * 1024) {
    const file = await this.call("getFile", { file_id: fileId }, signal);
    if (file.file_size > limit) throw channelError("MEDIA_TOO_LARGE", 400);
    if (
      typeof file.file_path !== "string" ||
      !/^voice\/[a-zA-Z0-9_.-]+$/.test(file.file_path)
    )
      throw channelError("MEDIA_UNSUPPORTED", 400);
    try {
      const response = await this.fetchImpl(
        `https://api.telegram.org/file/bot${this.token}/${file.file_path}`,
        {
          signal: AbortSignal.any([
            AbortSignal.timeout(30000),
            ...(signal ? [signal] : []),
          ]),
          redirect: "error",
        },
      );
      if (!response.ok) throw channelError("MEDIA_DOWNLOAD");
      return await boundedBytes(response, limit);
    } catch (error) {
      throw channelError(
        error.code === "MEDIA_TOO_LARGE" ? error.code : "MEDIA_DOWNLOAD",
        400,
      );
    }
  }
}
