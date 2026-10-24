import { randomUUID } from "node:crypto";
import { MAX_TELEGRAM_DOWNLOAD_BYTES } from "./telegram-client.js";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from "../assistants/agent-attachment-types.js";
import {
  VIDEO_CHUNK_BYTES,
  VIDEO_HEAD_BYTES,
  videoType,
} from "../assistants/agent-video-types.js";

const MB = 1024 * 1024;
// Telegram items that are files the agent's attachments may take.
const fileKinds = ["animation", "document", "photo", "video", "video_note"];
// Message content that never becomes an attachment (stickers, audio, polls, ...).
const otherKinds = [
  "sticker",
  "audio",
  "contact",
  "location",
  "venue",
  "poll",
  "dice",
  "game",
  "story",
  "paid_media",
];
const defaultNames = {
  photo: "photo.jpg",
  video: "video.mp4",
  video_note: "video-note.mp4",
  animation: "animation.mp4",
  document: "file",
};
// Kinds whose bytes may be a video, which may be up to Telegram's download limit;
// any other file must fit an attachment's 10 MB.
const videoLike = (kind, mime) =>
  ["video", "video_note", "animation"].includes(kind) || /^video\//.test(mime || "");

/**
 * The media part of one Telegram message (at most one), as the channel ledger keeps
 * it until dispatch: the file id, the size and name Telegram states, and a refusal
 * known before any download (a kind that is never a file, or a size beyond the limit).
 * An animation also carries a `document` field; the animation is taken.
 */
export function telegramParts(message) {
  const kind = fileKinds.find((k) => message[k]) || otherKinds.find((k) => k in message);
  if (!kind) return [];
  const base = { messageId: message.message_id, kind };
  if (!fileKinds.includes(kind)) return [{ ...base, refused: { reason: "kind" } }];
  // Photos come in several sizes; the largest is the original Telegram kept.
  const item = kind === "photo" ? [message.photo].flat().at(-1) : message[kind];
  const size = Number(item?.file_size) || null;
  const mime = typeof item?.mime_type === "string" ? item.mime_type.slice(0, 100) : null;
  const named = typeof item?.file_name === "string" && item.file_name.trim() !== "";
  const part = {
    ...base,
    fileId: String(item?.file_id || "").slice(0, 512),
    size,
    mime,
    name: named ? item.file_name.slice(0, 300) : defaultNames[kind],
    named,
  };
  const limit = videoLike(kind, mime)
    ? MAX_TELEGRAM_DOWNLOAD_BYTES
    : MAX_ATTACHMENT_BYTES;
  if (!part.fileId) return [{ ...part, refused: { reason: "download" } }];
  if (size > limit) return [{ ...part, refused: { reason: "tooLarge", mb: limit / MB } }];
  return [part];
}

// A failure that leaves the part undecided: the input waits and tries again.
const transient = (error) =>
  error?.code === "TELEGRAM_RATE_LIMIT" ||
  error?.status === 503 ||
  error?.key === "videoUploadsBusy";

function refusal(error) {
  if (error?.reason) return { reason: error.reason };
  if (error?.code === "MEDIA_TOO_LARGE" || error?.key === "videoTooLarge")
    return { reason: "tooLarge", mb: MAX_TELEGRAM_DOWNLOAD_BYTES / MB };
  if (error?.key === "attachmentTooLarge")
    return { reason: "tooLarge", mb: MAX_ATTACHMENT_BYTES / MB };
  if (error?.key === "attachmentUnsupported") return { reason: "type" };
  if (error?.key === "attachmentStorageFull") return { reason: "storage" };
  if (typeof error?.code === "string" && /^(MEDIA|TELEGRAM)_/.test(error.code))
    return { reason: "download" };
  return { reason: "failed" };
}

/**
 * Photos, documents and videos from the paired chat, handed to the agent as chat
 * attachments: each file is downloaded with the bot token (server-side only) and
 * staged through the same pipeline an AgentPier upload takes (agent-attachments.js:
 * byte sniffing, size and quota checks, the stamped copy in the agent's
 * attachments/ folder; videos through agent-video-uploads.js). Each part's outcome
 * is recorded on the input as it is decided, so a restart or a busy agent never
 * downloads a decided part again.
 */
export class TelegramMedia {
  constructor(service) {
    this.service = service;
  }
  /**
   * Decides every part of a dispatching input. Resolves with the parts (`staged` is
   * the attachment id, `refused` the reason); rejects, leaving the undecided parts
   * for a later try, when the work was interrupted or Telegram asked to wait.
   */
  async stage(channel, entry, signal) {
    const { assistants, ledger, store, clientFactory } = this.service;
    const attachments = assistants.attachments;
    const conversation = assistants.store.getConversation(channel.conversationId);
    // A restricted user's chat takes what her web chat takes: no videos.
    const byUser = typeof conversation.userId === "string";
    const media = entry.media.map((part) => ({ ...part }));
    // A staged copy that expired or was given up while the input waited is fetched again.
    for (const part of media)
      if (
        part.staged &&
        !attachments.staged(conversation.id, [part.staged], false).length
      )
        delete part.staged;
    let usable = media.filter((part) => part.staged).length;
    for (const part of media) {
      if (part.staged || part.refused) continue;
      if (usable >= MAX_ATTACHMENTS_PER_MESSAGE) {
        part.refused = { reason: "tooMany" };
        continue;
      }
      // Known to be a video: never downloaded for a chat that cannot take it.
      if (byUser && videoLike(part.kind, part.mime)) {
        part.refused = { reason: "video" };
        continue;
      }
      signal?.throwIfAborted();
      try {
        const body = await clientFactory(store.secret(channel.id)).download(
          part.fileId,
          signal,
          MAX_TELEGRAM_DOWNLOAD_BYTES,
        );
        part.staged = await this.save(conversation.id, part.name, body, byUser);
        usable++;
      } catch (error) {
        if (signal?.aborted || transient(error)) {
          ledger.patch(entry.id, { media });
          throw error;
        }
        part.refused = refusal(error);
      }
      ledger.patch(entry.id, { media });
    }
    return ledger.patch(entry.id, { media }).media;
  }
  async save(conversationId, name, body, byUser) {
    const { assistants } = this.service;
    const { attachments } = assistants;
    if (!videoType(body.subarray(0, VIDEO_HEAD_BYTES)))
      return (await assistants.admit(() => attachments.stage(conversationId, name, body)))
        .id;
    if (byUser) throw Object.assign(Error("video"), { reason: "video" });
    const videos = attachments.videos;
    const { upload } = await assistants.admit(() =>
      videos.begin(
        conversationId,
        name,
        body.length,
        body.subarray(0, VIDEO_HEAD_BYTES),
        randomUUID(),
      ),
    );
    try {
      for (let offset = 0; offset < body.length; offset += VIDEO_CHUNK_BYTES)
        await videos.receive(conversationId, upload, offset, [
          body.subarray(offset, offset + VIDEO_CHUNK_BYTES),
        ]);
      return (await assistants.admit(() => videos.finish(conversationId, upload))).id;
    } catch (error) {
      await videos.cancel(conversationId, upload).catch(() => {});
      throw error;
    }
  }
}

/**
 * The one notice for an input whose parts were not all passed on, naming each failed
 * part and why; null when nothing failed. `delivered` tells whether the rest reached
 * the agent.
 */
export function mediaNotice(messages, media = [], delivered) {
  const refused = media.filter((part) => part.refused);
  if (!refused.length) return null;
  const extra = refused.filter((part) => part.refused.reason === "tooMany").length;
  const parts = refused
    .filter((part) => part.refused.reason !== "tooMany")
    .map((part) => {
      const label = part.named
        ? messages.telegramMediaFile(part.name)
        : messages.telegramMediaLabels[part.kind] || messages.telegramMediaLabels.other;
      const reason =
        part.refused.reason === "tooLarge"
          ? messages.telegramMediaTooLarge(part.refused.mb)
          : messages.telegramMediaReasons[part.refused.reason] ||
            messages.telegramMediaReasons.failed;
      return `${label}: ${reason}`;
    });
  if (extra)
    parts.push(messages.telegramMediaTooMany(extra, MAX_ATTACHMENTS_PER_MESSAGE));
  const list = parts.join("; ");
  return delivered
    ? messages.telegramMediaPartly(list)
    : messages.telegramMediaNothing(list);
}
