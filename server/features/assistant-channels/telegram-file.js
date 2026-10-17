import {
  MAX_TELEGRAM_CAPTION,
  MAX_TELEGRAM_DOCUMENT_BYTES,
  MAX_TELEGRAM_PHOTO_BYTES,
} from "./telegram-client.js";

// Images Telegram shows as a photo; anything else, or a photo it refuses (too large,
// too wide), goes out as a document.
const photoTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

/** The method a shared file goes out with, or null when Telegram cannot take it. */
export function telegramFileMethod(file, refusedPhoto = false) {
  if (
    !refusedPhoto &&
    file.inline === true &&
    photoTypes.has(file.type) &&
    file.body.length <= MAX_TELEGRAM_PHOTO_BYTES
  )
    return "sendPhoto";
  return file.body.length <= MAX_TELEGRAM_DOCUMENT_BYTES ? "sendDocument" : null;
}

/**
 * Sends one queued file notice (kind "file", agent-shares.js) to the paired owner
 * chat: the copy AgentPier holds (`file` from AgentAttachments.content), its caption
 * as plain text. The outbox entry records each step like a text notice does, so a
 * restart never sends a delivered file again.
 */
export async function sendTelegramFile({ client, entry, file, save, signal, changed }) {
  if (entry.state !== "outbound" || entry.nextDeliveryAt > Date.now()) return;
  let method = telegramFileMethod(file, entry.photoRefused === true);
  if (!method) {
    save({ state: "delivery_failed", diagnostic: "FILE_TOO_LARGE" });
    changed();
    return;
  }
  const caption = Array.from(typeof entry.caption === "string" ? entry.caption : "")
    .slice(0, MAX_TELEGRAM_CAPTION)
    .join("");
  const send = () =>
    client.upload(
      method,
      { chat_id: entry.chatId, caption },
      { name: file.name, type: file.type, body: file.body },
      signal,
    );
  entry = save({ state: "delivering" });
  try {
    let result;
    try {
      result = await send();
    } catch (error) {
      if (!error.badRequest || method !== "sendPhoto") throw error;
      // Telegram refused the photo outright (its size or dimensions), so nothing
      // was delivered; it goes out once more as a document.
      entry = save({ state: "delivering", photoRefused: true });
      method = "sendDocument";
      result = await send();
    }
    if (
      !Number.isSafeInteger(result?.message_id) ||
      String(result.chat?.id) !== entry.chatId
    )
      throw Error("Unconfirmed destination");
    save({ state: "delivered", diagnostic: null, remoteMessageIds: [result.message_id] });
  } catch (error) {
    if (error.code === "TELEGRAM_RATE_LIMIT")
      save({
        state: "outbound",
        diagnostic: "TELEGRAM_RATE_LIMIT",
        nextDeliveryAt:
          Date.now() + Math.max(1, Math.min(error.retryAfter || 30, 3600)) * 1000,
      });
    else if (error.rejected)
      save({ state: "delivery_failed", diagnostic: "TELEGRAM_REJECTED" });
    else save({ state: "delivery_uncertain", diagnostic: "DELIVERY_UNCERTAIN" });
  }
  changed();
}
