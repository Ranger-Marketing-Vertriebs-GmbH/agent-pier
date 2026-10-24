import { randomUUID } from "node:crypto";
import { channelError } from "./telegram-client.js";
import { telegramParts } from "./telegram-media.js";
const inboxSchema =
  "CREATE TABLE IF NOT EXISTS channel_inbox(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), update_id INTEGER NOT NULL, message_id INTEGER NOT NULL, body TEXT NOT NULL, chat_id TEXT NOT NULL, UNIQUE(channel_id,chat_id,message_id))";
// "merged": an album item whose files and caption joined the album's first input.
const terminal = ["delivered", "failed", "cancelled", "reviewed", "merged"];
export const queueLimit = 200;
/**
 * Telegram sends an album as one message per item, sharing a media_group_id, within
 * about a second; long polling may split them across responses. The album's first
 * input waits until no item came for this long, so later items join it.
 */
export const ALBUM_QUIET_MS = 2500;
const content = [
  "text",
  "voice",
  "caption",
  "photo",
  "sticker",
  "document",
  "audio",
  "video",
  "video_note",
  "animation",
  "contact",
  "location",
  "venue",
  "poll",
  "dice",
  "game",
  "story",
  "paid_media",
];
// Telegram formatting that marks text as not the owner's own words, as the same
// Markdown does in the web chat: quotes, code, links behind text, struck-through text.
const quoting = new Set([
  "blockquote",
  "expandable_blockquote",
  "code",
  "pre",
  "text_link",
  "strikethrough",
]);
/**
 * The [start, end) ranges of `text` (UTF-16 offsets, as Telegram counts) that such
 * entities cover; the owner proofs leave them out (`parseOwnerText`). More than
 * Telegram's 100 entities hide the whole text.
 */
export function telegramHidden(entities, text) {
  if (!Array.isArray(entities)) return [];
  if (entities.length > 100) return text ? [[0, text.length]] : [];
  return entities.flatMap((e) =>
    quoting.has(e?.type) &&
    Number.isInteger(e.offset) &&
    Number.isInteger(e.length) &&
    e.offset >= 0 &&
    e.length > 0 &&
    e.offset < text.length
      ? [[e.offset, Math.min(text.length, e.offset + e.length)]]
      : [],
  );
}
/**
 * Telegram service messages (pinned messages, chat member or title changes and
 * the like) carry no user content and are acknowledged without any reply.
 */
export const serviceMessage = (message) => !content.some((key) => key in message);
/**
 * Entries that wait for an owner decision in AgentPier. They stay active (and
 * count against the queue limit) but no longer hold later inputs back; nothing
 * in this lane is ever sent or dispatched again automatically.
 */
export const reviewStates = [
  "delivery_uncertain",
  "delivery_failed",
  "transcription_failed",
  "reply_unavailable",
  "model_reviewed",
];
export class ChannelLedger {
  constructor(db, { maxVoiceSeconds = 600 } = {}) {
    this.db = db;
    this.maxVoiceSeconds = maxVoiceSeconds;
    const table = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='channel_inbox'",
      )
      .get()?.sql;
    // Telegram restarts update ids after a quiet week, so inputs are identified by
    // chat message and ordered by arrival (rowid) instead of by update id.
    if (
      table &&
      (!table.includes("chat_id") || table.includes("UNIQUE(channel_id,update_id)"))
    )
      db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE channel_inbox RENAME TO channel_inbox_legacy;
        ${inboxSchema};
        INSERT INTO channel_inbox SELECT id,channel_id,update_id,message_id,body,${
          table.includes("chat_id")
            ? "chat_id"
            : "COALESCE(json_extract(body,'$.chatId'),'')"
        } FROM channel_inbox_legacy ORDER BY update_id;
        DROP TABLE channel_inbox_legacy;
        COMMIT;`);
    db.exec(`${inboxSchema};`);
    for (const row of db.prepare("SELECT id,body FROM channel_inbox").all()) {
      const entry = JSON.parse(row.body);
      if (entry.state === "dispatching") this.patch(row.id, { state: "queued" });
      if (entry.state === "transcribing")
        this.patch(row.id, {
          state: "transcription_failed",
          diagnostic: "TRANSCRIPTION_INTERRUPTED",
        });
      if (entry.state === "delivering")
        this.patch(row.id, {
          state: "delivery_uncertain",
          diagnostic: "DELIVERY_UNCERTAIN",
        });
    }
  }
  get(id) {
    const row = this.db.prepare("SELECT body FROM channel_inbox WHERE id=?").get(id);
    if (!row) throw channelError("CHANNEL_NOT_FOUND", 404);
    return JSON.parse(row.body);
  }
  list(channelId, limit = 200) {
    return this.db
      .prepare(
        "SELECT body FROM channel_inbox WHERE channel_id=? ORDER BY rowid DESC LIMIT ?",
      )
      .all(channelId, limit)
      .map((r) => JSON.parse(r.body))
      .reverse();
  }
  active(channelId) {
    return this.db
      .prepare("SELECT body FROM channel_inbox WHERE channel_id=? ORDER BY rowid")
      .all(channelId)
      .map((r) => JSON.parse(r.body))
      .filter((r) => !terminal.includes(r.state));
  }
  // Inputs still moving through transcription, model execution and delivery,
  // in arrival order; the first one is the head every worker acts on.
  queue(channelId) {
    return this.active(channelId).filter((r) => !reviewStates.includes(r.state));
  }
  // Review-lane inputs plus an unknown model outcome that still holds the queue
  // until the attempt is reviewed in the assistant chat.
  needsAttention(channelId) {
    return this.active(channelId).filter(
      (r) => reviewStates.includes(r.state) || r.state === "model_uncertain",
    );
  }
  accept(channel, update, now = Date.now()) {
    const message = update.message;
    const existing = this.db
      .prepare(
        "SELECT id FROM channel_inbox WHERE channel_id=? AND chat_id=? AND message_id=?",
      )
      .get(channel.id, String(message.chat.id), message.message_id);
    if (existing) return this.get(existing.id);
    const voice = message.voice;
    // A caption is the text of a photo, document or video.
    const own = typeof message.text === "string";
    const raw = own ? message.text : message.caption;
    const text = typeof raw === "string" ? raw.slice(0, 65536) : "";
    const hidden = telegramHidden(
      own ? message.entities : message.caption_entities,
      text,
    );
    const media = voice ? [] : telegramParts(message);
    const group =
      typeof message.media_group_id === "string" && media.length
        ? message.media_group_id.slice(0, 100)
        : null;
    const head =
      group &&
      this.active(channel.id).find(
        (e) =>
          e.mediaGroupId === group &&
          e.chatId === String(message.chat.id) &&
          e.state === "queued",
      );
    if (head) return this.merge(head, update, { text, hidden, media }, now);
    if (this.active(channel.id).length >= queueLimit)
      throw channelError("CHANNEL_QUEUE_FULL", 409);
    // Rejected before any download: the sender is told why (see TelegramIngress). An
    // album item waits, since a later item may still bring a caption or a file.
    const diagnostic =
      voice && Number(voice.duration) > this.maxVoiceSeconds
        ? "VOICE_TOO_LONG"
        : !voice && !text.trim() && !group && !media.some((part) => !part.refused)
          ? "MEDIA_UNSUPPORTED"
          : null;
    const entry = {
      ...this.source(channel, update),
      kind: voice ? "voice" : media.length ? "media" : "text",
      state: diagnostic ? "failed" : voice ? "voice_pending" : "queued",
      text,
      ...(hidden.length ? { hidden } : {}),
      forwarded: !!message.forward_origin,
      ...(media.length ? { media } : {}),
      ...(group ? { mediaGroupId: group, collectUntil: now + ALBUM_QUIET_MS } : {}),
      requestId: null,
      attemptId: null,
      diagnostic,
      ...(voice
        ? {
            voice: {
              fileId: String(voice.file_id || "").slice(0, 512),
              size: Number(voice.file_size) || null,
              duration: Number(voice.duration) || null,
              mime: voice.mime_type || "audio/ogg",
            },
          }
        : {}),
    };
    this.insert(update, entry);
    return entry;
  }
  // The fields every input row has: its source message and arrival.
  source(channel, update) {
    const message = update.message;
    return {
      id: randomUUID(),
      channelId: channel.id,
      chatId: String(message.chat.id),
      userId: String(message.from.id),
      conversationId: channel.conversationId,
      updateId: update.update_id,
      messageId: message.message_id,
      receipt: "pending",
      createdAt: new Date().toISOString(),
    };
  }
  insert(update, entry) {
    this.db
      .prepare("INSERT INTO channel_inbox VALUES(?,?,?,?,?,?)")
      .run(
        entry.id,
        entry.channelId,
        update.update_id,
        update.message.message_id,
        JSON.stringify(entry),
        entry.chatId,
      );
  }
  /**
   * Adds an album item to the album's waiting input: its file in message order and
   * its caption (Telegram puts it on one item). The item keeps a row of its own, so a
   * repeated update is recognised and the item gets its own 👀.
   */
  merge(head, update, { text, hidden, media }, now) {
    let joined = head.text;
    let ranges = head.hidden || [];
    if (text.trim() && joined.trim()) {
      const offset = joined.length + 2;
      joined = `${joined}\n\n${text}`.slice(0, 65536);
      ranges = [...ranges, ...hidden.map(([a, b]) => [a + offset, b + offset])]
        .filter(([a]) => a < joined.length)
        .map(([a, b]) => [a, Math.min(b, joined.length)]);
    } else if (text.trim()) [joined, ranges] = [text, hidden];
    this.insert(update, {
      ...this.source({ id: head.channelId, conversationId: head.conversationId }, update),
      kind: "media",
      state: "merged",
      mergedInto: head.id,
      text: "",
    });
    return this.patch(head.id, {
      text: joined,
      ...(ranges.length ? { hidden: ranges } : {}),
      forwarded: head.forwarded || !!update.message.forward_origin,
      media: [...head.media, ...media].sort((a, b) => a.messageId - b.messageId),
      collectUntil: now + ALBUM_QUIET_MS,
    });
  }
  pendingReceipt(channelId, chatId, userId) {
    const row = this.db
      .prepare(
        "SELECT body FROM channel_inbox WHERE channel_id=? AND json_extract(body,'$.chatId')=? AND json_extract(body,'$.userId')=? AND json_extract(body,'$.receipt')='pending' ORDER BY rowid LIMIT 1",
      )
      .get(channelId, chatId, userId);
    return row ? JSON.parse(row.body) : null;
  }
  patch(id, patch) {
    const entry = { ...this.get(id), ...patch };
    this.db
      .prepare("UPDATE channel_inbox SET body=? WHERE id=?")
      .run(JSON.stringify(entry), id);
    return entry;
  }
  public(channelId) {
    return this.db
      .prepare(
        `SELECT body FROM channel_inbox WHERE channel_id=? AND (json_extract(body,'$.state') NOT IN (${terminal.map(() => "?").join(",")}) OR rowid IN (SELECT rowid FROM channel_inbox WHERE channel_id=? ORDER BY rowid DESC LIMIT 200)) ORDER BY rowid`,
      )
      .all(channelId, ...terminal, channelId)
      .map((r) => JSON.parse(r.body))
      .filter((r) => r.state !== "merged")
      .map(
        ({
          id,
          kind,
          state,
          text,
          diagnostic,
          diagnosticDetail,
          requestId,
          attemptId,
          createdAt,
          remoteMessageIds,
        }) => ({
          id,
          needsReview: reviewStates.includes(state),
          kind,
          state,
          text,
          diagnostic,
          diagnosticDetail,
          requestId,
          attemptId,
          createdAt,
          remoteMessageIds,
        }),
      );
  }
}
