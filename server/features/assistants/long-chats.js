import { chatBusy, chatProblem } from "./agent-chats.js";
import { assistantProblem } from "./assistant-validation.js";
import { refuseClosedChat } from "./conversation-turns.js";
import { dispatchQueued } from "./queued-dispatch.js";

// OpenClaw 2026.10.3 `sessions.compact` {key} summarises a session's history with the
// session's own model (trigger "manual", sessions-compaction-runner) and answers once
// it is done: { ok, compacted, reason, result }. It refuses a session with an active
// run or queued work (INVALID_REQUEST) and answers `compacted: false` when there is
// nothing to summarise. Unlike the compaction before a run, it never runs the
// pre-compaction memory flush (agent-runner-memory), so it writes no memory.
const compactTimeoutMs = 10 * 60000;
// A hidden hint shows again once the context grew by half, or by this many tokens,
// over the size it had when it was hidden, whichever comes first.
export const dismissedGrowthTokens = 50000;

/** The context size from which a hint hidden at `tokens` shows again. */
export const reappearsAt = (tokens) =>
  tokens + Math.min(Math.round(tokens / 2), dismissedGrowthTokens);

// Whose chat it is: a user's own, or the owner's.
const personOf = (conversation) =>
  typeof conversation.userId === "string" ? conversation.userId : "owner";
// The Gateway's refusal of a session that is working; its other answers are failures.
const working = (error) =>
  error?.code === "INVALID_REQUEST" &&
  /active run|queued work/.test(error.remoteMessage || "");

/**
 * The long-chat hint's actions (AGENTPIER-186): the person whose chat it is lets
 * OpenClaw summarise its history now, in its own native session (key, chat and
 * main-chat deliveries unchanged), or hides the hint until the chat grew clearly
 * further. Hidden hints are kept per person and chat with the size they had.
 */
export class LongChats {
  constructor(service) {
    this.service = service;
    this.running = new Map();
    this.db = service.store.db;
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_long_chat_dismissals (conversation_id TEXT NOT NULL, person TEXT NOT NULL, tokens INTEGER NOT NULL, dismissed_at TEXT NOT NULL, PRIMARY KEY(conversation_id, person))",
    );
  }
  /** Whether the chat's history is being summarised on request now. */
  compacting(conversationId) {
    return this.running.has(conversationId);
  }
  /**
   * Whether its person hid the hint at a size the context has not clearly outgrown. A
   * context smaller than when it was hidden was summarised meanwhile (on request or by
   * OpenClaw itself): the hidden hint is forgotten, so a chat that grows long again
   * shows it.
   */
  hidden(conversation, tokens) {
    const person = personOf(conversation);
    const row = this.db
      .prepare(
        "SELECT tokens FROM assistant_long_chat_dismissals WHERE conversation_id=? AND person=?",
      )
      .get(conversation.id, person);
    if (!row) return false;
    if (tokens < row.tokens) {
      this.unhide(conversation.id, person);
      return false;
    }
    return tokens < reappearsAt(row.tokens);
  }
  unhide(conversationId, person) {
    this.db
      .prepare(
        "DELETE FROM assistant_long_chat_dismissals WHERE conversation_id=? AND person=?",
      )
      .run(conversationId, person);
  }
  /**
   * Summarises the chat's history now. A second request while one runs joins it, so a
   * double click compacts once. Refused while a turn runs, a message waits or team
   * work reports into the chat, and for a chat that takes no turns.
   */
  async summarise(conversationId) {
    const service = this.service;
    let job = this.running.get(conversationId);
    if (job) return job;
    await service.admit(() => {
      job = this.running.get(conversationId);
      if (job) return;
      const conversation = service.store.getConversation(conversationId);
      refuseClosedChat(service, conversation);
      service.requireReady();
      if (chatBusy(service, conversationId)) throw chatProblem("CHAT_BUSY");
      job = this.compact(conversation);
    });
    return job;
  }
  // Holds the chat busy while the Gateway compacts; admission is not held meanwhile.
  compact(conversation) {
    const service = this.service;
    const id = conversation.id;
    const client = service.runtime.client;
    const job = client
      .call(
        "sessions.compact",
        { key: conversation.runtimeSessionKey },
        { timeoutMs: compactTimeoutMs },
      )
      .then(
        (result) => {
          if (result?.compacted !== true) throw chatProblem("CHAT_COMPACT_NOTHING");
          // A hint hidden before measured the history that is summarised now.
          this.unhide(id, personOf(conversation));
          return { compacted: true };
        },
        (error) => {
          if (working(error)) throw chatProblem("CHAT_BUSY");
          // The Gateway went away before it answered. A timeout is shown as a failure
          // (OpenClaw may still finish the summary; the chat shows it once it did).
          if (!error?.answered && error?.code !== "TIMEOUT")
            throw assistantProblem("unavailable", 503);
          throw chatProblem("CHAT_COMPACT_FAILED");
        },
      )
      .finally(() => {
        this.running.delete(id);
        service.changed({ conversationId: id });
        // A message queued meanwhile goes out now (queued-dispatch.js).
        dispatchQueued(service, id).catch(() => {});
      });
    // Its refusal reaches the request; a request that went away leaves it unheard.
    job.catch(() => {});
    this.running.set(id, job);
    service.changed({ conversationId: id });
    return job;
  }
  /**
   * Hides the hint of a chat at its current context size, read from the Gateway, until
   * the context grew clearly further (reappearsAt).
   */
  async dismiss(conversationId) {
    const service = this.service;
    const conversation = service.store.getConversation(conversationId);
    refuseClosedChat(service, conversation);
    service.requireReady();
    const history = await service.runtime.client.call("chat.history", {
      sessionKey: conversation.runtimeSessionKey,
      limit: 1,
    });
    const tokens = history?.sessionInfo?.totalTokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw chatProblem("CHAT_COMPACT_FAILED");
    this.db
      .prepare(
        "INSERT INTO assistant_long_chat_dismissals VALUES(?,?,?,?) ON CONFLICT(conversation_id, person) DO UPDATE SET tokens=excluded.tokens, dismissed_at=excluded.dismissed_at",
      )
      .run(
        conversationId,
        personOf(conversation),
        tokens,
        new Date(service.now?.() ?? Date.now()).toISOString(),
      );
    service.changed({ conversationId });
    return { dismissed: true };
  }
  /** A deleted chat's hidden hints go with it (chat-removal.js). */
  forget(conversationId) {
    this.db
      .prepare("DELETE FROM assistant_long_chat_dismissals WHERE conversation_id=?")
      .run(conversationId);
  }
}
