import { followUpTelegram } from "../assistants/follow-up-target.js";
import {
  completionRun,
  completionTranscriptLimit,
} from "../assistants/exec-continuation.js";
import { boundedText, completeMessage, withNote } from "../assistants/history-text.js";
import { telegramMessages } from "./telegram-messages.js";

/**
 * The replies of runs AgentPier did not start, for the owner's paired Telegram chat.
 * When a background command exits, OpenClaw runs the chat's session once more on its
 * own (exec-continuation.js); its answer reaches the web chat but belongs to no
 * Telegram input. Each such run that ends in a chat whose latest turn came from the
 * paired chat (follow-up-target.js) is recorded once, durably, by its run id; its
 * final text then goes out as one outbox notice (`follow-up-reply`), sent, split and
 * retried like every other notice (telegram-outbox.js).
 *
 * Only a run the session's transcript shows as an exec completion qualifies: every
 * other run without an attempt (a check-in, a routine's or hook's run in its own
 * session, a memory flush) has its own delivery or none. A run with an attempt is
 * an AgentPier turn, delivered as that turn's reply (telegram-delivery.js). Nothing
 * is read back from older history: a run is recorded only from its live end event.
 */
const schema =
  "CREATE TABLE IF NOT EXISTS channel_follow_ups(run_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL)";
// History can trail the run's end briefly (telegram-delivery.js replyGraceMs).
export const followUpGraceMs = 60_000;
// A run whose transcript or reply stays unreadable this long is given up.
export const followUpExpiryMs = 10 * 60_000;
// OpenClaw's silent replies, never sent anywhere.
const silent = (text) => ["NO_REPLY", "HEARTBEAT_OK"].includes(text.trim());

export class TelegramFollowUps {
  constructor(service) {
    this.service = service;
    this.db = service.store.db;
    this.db.exec(schema);
  }
  /** Takes every Gateway `agent` event; only a run's end matters. */
  observe(payload) {
    const { runId, sessionKey } = payload || {};
    if (
      payload?.stream !== "lifecycle" ||
      !["end", "error"].includes(payload.data?.phase) ||
      typeof runId !== "string" ||
      !runId ||
      typeof sessionKey !== "string"
    )
      return;
    try {
      this.record(runId, sessionKey);
    } catch {
      // A broken record never reaches the event hub; the web chat still has the reply.
    }
  }
  record(runId, sessionKey) {
    const { assistants } = this.service;
    if (!assistants.ledger || assistants.ledger.attemptForRun(runId)) return;
    const conversation = assistants.store
      .listConversations()
      .find((c) => c.runtimeSessionKey === sessionKey && !c.archivedAt);
    if (!conversation) return;
    const agent = assistants.store.getAssistant(conversation.assistantId);
    const target = followUpTelegram(assistants, this.service, agent, conversation);
    if (!target) return;
    const row = {
      runId,
      sessionKey,
      conversationId: conversation.id,
      ...target,
      // Telegram inputs whose replies are still on their way go out first.
      after: this.service.ledger.queue(target.channelId).map((e) => e.id),
      endedAt: this.service.now(),
      state: "pending",
    };
    const added = this.db
      .prepare("INSERT OR IGNORE INTO channel_follow_ups VALUES(?,?,?,?)")
      .run(runId, target.channelId, row.state, JSON.stringify(row));
    if (added.changes) assistants.changed?.({ conversationId: conversation.id });
  }
  all(channelId) {
    return this.db
      .prepare("SELECT body FROM channel_follow_ups WHERE channel_id=? ORDER BY rowid")
      .all(channelId)
      .map((r) => JSON.parse(r.body));
  }
  pending(channelId) {
    return this.db
      .prepare(
        "SELECT body FROM channel_follow_ups WHERE channel_id=? AND state='pending' ORDER BY rowid",
      )
      .all(channelId)
      .map((r) => JSON.parse(r.body));
  }
  patch(row, patch) {
    const next = { ...row, ...patch };
    this.db
      .prepare("UPDATE channel_follow_ups SET state=?, body=? WHERE run_id=?")
      .run(next.state, JSON.stringify(next), row.runId);
    return next;
  }
  // Ends a run without a notice (`dropped`), with the reason as a code only.
  drop(row, diagnostic) {
    return this.patch(row, { state: "dropped", diagnostic });
  }
  async process(channelId, signal) {
    for (const row of this.pending(channelId)) {
      if (signal.aborted) return;
      try {
        await this.settle(row, signal);
      } catch {
        // Retried on the next pass until it expires.
      }
    }
  }
  async settle(row, signal) {
    const { assistants: a, store, outbox } = this.service;
    const channel = store.get(row.channelId);
    // The chat it was recorded for, still paired: never another or a re-paired one.
    if (
      !channel.enabled ||
      channel.chatId !== row.chatId ||
      channel.userId !== row.userId
    )
      return this.drop(row, "CHANNEL_DESTINATION_CHANGED");
    const queued = new Set(this.service.ledger.queue(row.channelId).map((e) => e.id));
    if (row.after?.some((id) => queued.has(id))) return;
    const expired = this.service.now() - row.endedAt >= followUpExpiryMs;
    if (!row.proven) {
      const client = a.runtime?.client;
      let page = null;
      if (client?.ready)
        page = await client
          .call(
            "sessions.get",
            { key: row.sessionKey, limit: completionTranscriptLimit },
            { timeoutMs: 5000 },
          )
          .catch(() => null);
      if (signal.aborted) return;
      if (!page) return expired ? this.drop(row, "TRANSCRIPT_UNAVAILABLE") : undefined;
      if (!completionRun(page.messages, row.runId))
        return this.drop(row, "NOT_COMPLETION");
      row = this.patch(row, { proven: true });
    }
    const history = await a.history(row.conversationId);
    if (signal.aborted) return;
    if (history.stale) return expired ? this.drop(row, "REPLY_UNAVAILABLE") : undefined;
    const message = history.messages
      .filter((m) => m.role === "assistant" && m.runId === row.runId)
      .at(-1);
    if (!message?.text?.trim() && message?.cut !== true && message?.partial !== true)
      return this.service.now() - row.endedAt >= followUpGraceMs
        ? this.drop(row, "REPLY_WITHOUT_TEXT")
        : undefined;
    // The history page cuts long replies; this one is read on its own. Like a lead's
    // follow-up it is one outbox notice, bounded by the outbox's 65536 characters.
    const reply = boundedText(await completeMessage(a, row.conversationId, message));
    if (signal.aborted) return;
    if (!reply.text.trim() || silent(reply.text)) return this.drop(row, "SILENT_REPLY");
    const text = reply.cut
      ? withNote(reply.text, telegramMessages(channel).telegramReplyIncomplete)
      : reply.text;
    const entry = outbox.enqueue({
      key: `follow-up-reply:${row.runId}`,
      source: { channelId: row.channelId, chatId: row.chatId, userId: row.userId },
      kind: "follow-up-reply",
      text,
    });
    this.patch(row, { state: "queued", outboxId: entry.id, diagnostic: null });
    a.changed?.({ conversationId: row.conversationId });
  }
}
