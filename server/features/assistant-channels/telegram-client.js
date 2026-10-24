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
export const telegramApiRoot = "https://api.telegram.org";
// Files go out as multipart uploads, and only through these methods; every other
// call is JSON. Telegram takes photos up to 10 MB and documents up to 50 MB.
export const telegramUploads = { sendPhoto: "photo", sendDocument: "document" };
export const MAX_TELEGRAM_PHOTO_BYTES = 10 * 1024 * 1024;
export const MAX_TELEGRAM_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const MAX_TELEGRAM_CAPTION = 1024;
// What getFile lets a bot download at most (Bot API, "getFile").
export const MAX_TELEGRAM_DOWNLOAD_BYTES = 20 * 1024 * 1024;
// The folders of Telegram's file paths a download may come from.
const voiceFolders = ["voice"];
const mediaFolders = ["photos", "documents", "videos", "animations", "video_notes"];
// Methods that deliver a message: a lost answer leaves the delivery uncertain.
const delivering = new Set(["sendMessage", ...Object.keys(telegramUploads)]);
export class TelegramClient {
  // `apiRoot` is a test seam for a local fake Bot API; production uses Telegram's.
  constructor({ token, fetchImpl = fetch, apiRoot = telegramApiRoot }) {
    if (typeof token !== "string" || !/^\d+:[a-zA-Z0-9_-]{20,200}$/.test(token))
      throw channelError("TELEGRAM_TOKEN", 400);
    Object.assign(this, { token, fetchImpl, apiRoot });
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
    return this.request(
      method,
      { headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) },
      signal,
      method === "getUpdates" ? 35000 : 20000,
    );
  }
  /**
   * Sends one file (`{ name, type, body }`) with sendPhoto or sendDocument as a
   * multipart upload. `params` are the method's plain fields (chat_id, caption).
   */
  async upload(method, params, file, signal) {
    const field = Object.hasOwn(telegramUploads, method) && telegramUploads[method];
    const limit =
      method === "sendPhoto" ? MAX_TELEGRAM_PHOTO_BYTES : MAX_TELEGRAM_DOCUMENT_BYTES;
    if (!field || !Buffer.isBuffer(file?.body) || file.body.length > limit)
      throw channelError("TELEGRAM_METHOD", 400);
    const form = new FormData();
    for (const [key, value] of Object.entries(params))
      if (value !== undefined && value !== "") form.append(key, String(value));
    form.append(field, new Blob([file.body], { type: file.type }), file.name);
    return this.request(method, { body: form }, signal, 120000);
  }
  async request(method, init, signal, timeout) {
    const combined = AbortSignal.any([
      AbortSignal.timeout(timeout),
      ...(signal ? [signal] : []),
    ]);
    let response, data;
    try {
      response = await this.fetchImpl(`${this.apiRoot}/bot${this.token}/${method}`, {
        method: "POST",
        ...init,
        signal: combined,
        redirect: "error",
      });
      data = JSON.parse((await boundedBytes(response, 2 * 1024 * 1024)).toString());
    } catch {
      throw channelError(
        delivering.has(method) ? "DELIVERY_UNCERTAIN" : "TELEGRAM_UNAVAILABLE",
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
        delivering.has(method) ? "DELIVERY_UNCERTAIN" : "TELEGRAM_UNAVAILABLE",
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
    try {
      return await this.download(fileId, signal, limit, voiceFolders);
    } catch (error) {
      // A voice note is not retried by itself; its transcription can be.
      if (error.code === "MEDIA_UNAVAILABLE") throw channelError("MEDIA_DOWNLOAD", 400);
      throw error;
    }
  }
  /**
   * One file a message carries (getFile, then the file URL), bounded by `limit` before
   * and while it is read. Only files from Telegram's folders in `folders` are fetched.
   * The token is part of both URLs, so no error carries Telegram's answer or the URL.
   * A file Telegram refuses (4xx) fails with MEDIA_DOWNLOAD; a network error, timeout
   * or server error with MEDIA_UNAVAILABLE, which a later try may overcome.
   */
  async download(fileId, signal, limit, folders = mediaFolders) {
    const file = await this.call("getFile", { file_id: fileId }, signal);
    if (file.file_size > limit) throw channelError("MEDIA_TOO_LARGE", 400);
    const [folder, name, rest] =
      typeof file.file_path === "string" ? file.file_path.split("/") : [];
    if (
      !folders.includes(folder) ||
      rest !== undefined ||
      !/^[a-zA-Z0-9_.-]+$/.test(name)
    )
      throw channelError("MEDIA_UNSUPPORTED", 400);
    try {
      const response = await this.fetchImpl(
        `${this.apiRoot}/file/bot${this.token}/${folder}/${name}`,
        {
          signal: AbortSignal.any([
            AbortSignal.timeout(60000),
            ...(signal ? [signal] : []),
          ]),
          redirect: "error",
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        const lasting = response.status < 500 && response.status !== 429;
        throw channelError(
          lasting ? "MEDIA_DOWNLOAD" : "MEDIA_UNAVAILABLE",
          lasting ? 400 : 503,
        );
      }
      return await boundedBytes(response, limit);
    } catch (error) {
      if (["MEDIA_TOO_LARGE", "MEDIA_DOWNLOAD"].includes(error.code))
        throw channelError(error.code, 400);
      throw channelError("MEDIA_UNAVAILABLE", 503);
    }
  }
}
