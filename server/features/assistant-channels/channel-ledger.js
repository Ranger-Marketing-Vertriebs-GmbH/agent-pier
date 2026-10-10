import { randomUUID } from "node:crypto";
import { channelError } from "./telegram-client.js";
const inboxSchema =
  "CREATE TABLE IF NOT EXISTS channel_inbox(id TEXT PRIMARY KEY, channel_id TEXT NOT NULL REFERENCES channels(id), update_id INTEGER NOT NULL, message_id INTEGER NOT NULL, body TEXT NOT NULL, chat_id TEXT NOT NULL, UNIQUE(channel_id,chat_id,message_id))";
const terminal = ["delivered", "failed", "cancelled", "reviewed"];
export const queueLimit = 200;
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
  accept(channel, update) {
    const message = update.message;
    const existing = this.db
      .prepare(
        "SELECT id FROM channel_inbox WHERE channel_id=? AND chat_id=? AND message_id=?",
      )
      .get(channel.id, String(message.chat.id), message.message_id);
    if (existing) return this.get(existing.id);
    if (this.active(channel.id).length >= queueLimit)
      throw channelError("CHANNEL_QUEUE_FULL", 409);
    const voice = message.voice;
    const text = typeof message.text === "string" ? message.text.slice(0, 65536) : "";
    // Rejected before any download: the sender is told why (see TelegramIngress).
    const diagnostic =
      voice && Number(voice.duration) > this.maxVoiceSeconds
        ? "VOICE_TOO_LONG"
        : !voice && !text.trim()
          ? "MEDIA_UNSUPPORTED"
          : null;
    const entry = {
      id: randomUUID(),
      channelId: channel.id,
      chatId: String(message.chat.id),
      userId: String(message.from.id),
      conversationId: channel.conversationId,
      updateId: update.update_id,
      messageId: message.message_id,
      kind: voice ? "voice" : "text",
      state: diagnostic ? "failed" : voice ? "voice_pending" : "queued",
      text,
      forwarded: !!message.forward_origin,
      ...(diagnostic === "MEDIA_UNSUPPORTED" &&
      typeof message.caption === "string" &&
      message.caption.trim()
        ? { captionIgnored: true }
        : {}),
      receipt: "pending",
      requestId: null,
      attemptId: null,
      diagnostic,
      createdAt: new Date().toISOString(),
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
    this.db
      .prepare("INSERT INTO channel_inbox VALUES(?,?,?,?,?,?)")
      .run(
        entry.id,
        channel.id,
        update.update_id,
        message.message_id,
        JSON.stringify(entry),
        entry.chatId,
      );
    return entry;
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
