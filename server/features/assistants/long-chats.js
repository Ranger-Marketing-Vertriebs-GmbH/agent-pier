import { chatBusy, chatProblem } from "./agent-chats.js";
import { assistantProblem } from "./assistant-validation.js";
import { refuseClosedChat } from "./conversation-turns.js";
import { dispatchQueued } from "./queued-dispatch.js";
import { watchCompactEnd } from "./compaction-watch.js";

// OpenClaw 2026.10.3 `sessions.compact` {key} summarises a session's history with the
// session's own model (trigger "manual", sessions-compaction-runner) and answers once
// it is done: { ok, compacted, reason, result }. It refuses a session with an active
// run or queued work (INVALID_REQUEST) and answers `compacted: false` when there is
// nothing to summarise. Unlike the compaction before a run, it never runs the
// pre-compaction memory flush (agent-runner-memory), so it writes no memory. A large
// history takes long: the request answers after `answerMs` that it still runs, the
// chat stays compacting until the Gateway ended it, at most `maxMs` (compactions.js).
export const compactTiming = { answerMs: 10 * 60000, maxMs: 60 * 60000, pollMs: 30000 };
// A hidden hint shows again once the context grew by half, or by this many tokens,
// over the size it had when it was hidden, whichever comes first.
export const dismissedGrowthTokens = 50000;

/** The context size from which a hint hidden at `tokens` shows again. */
export const reappearsAt = (tokens) =>
  tokens + Math.min(Math.round(tokens / 2), dismissedGrowthTokens);

/** The table of hidden hints, per chat and person (private: operations/private-tables.js). */
export const dismissalTable =
  "CREATE TABLE IF NOT EXISTS assistant_long_chat_dismissals (conversation_id TEXT NOT NULL, person TEXT NOT NULL, tokens INTEGER NOT NULL, dismissed_at TEXT NOT NULL, PRIMARY KEY(conversation_id, person))";

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
    // Watches of summaries that outlived their request, and how such ones ended.
    this.stops = new Map();
    this.outcomes = new Map();
    this.timing = { ...compactTiming };
    this.db = service.store.db;
    this.db.exec(dismissalTable);
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
  /**
   * Holds the chat busy until the Gateway ended the compaction; admission is not held
   * meanwhile. The request answers after `answerMs` at the latest: then the summary
   * still runs on the Gateway (holding the session's lifecycle lock, so a send would
   * only wait for it), and the chat stays compacting until compaction-watch.js sees
   * its end, the Gateway goes away, or `maxMs` passed. An end the request no longer
   * reported is the chat's notice (outcome).
   */
  compact(conversation) {
    const service = this.service;
    const id = conversation.id;
    const sessionKey = conversation.runtimeSessionKey;
    const client = service.runtime.client;
    const generation = service.runtime.generationId ?? null;
    const { answerMs, maxMs, pollMs } = this.timing;
    this.outcomes.delete(id);
    let answered = false;
    let settled = false;
    let timer;
    // The upper bound, also when the client's own timeout never fires.
    const bound = setTimeout(() => finish("unknown"), maxMs);
    bound.unref?.();
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(bound);
      this.stops.get(id)?.();
      this.stops.delete(id);
      this.running.delete(id);
      // A hint hidden before measured the history that is summarised now.
      if (outcome === "compacted") this.unhide(id, personOf(conversation));
      else if (answered) {
        console.warn(`Summarising chat ${id} ended after its request: ${outcome}`);
        this.outcomes.set(id, outcome === "busy" ? "failed" : outcome);
      }
      service.changed({ conversationId: id });
      // A message queued meanwhile goes out now, once (queued-dispatch.js).
      if (!service.closed) dispatchQueued(service, id).catch(() => {});
    };
    const call = client.call(
      "sessions.compact",
      { key: sessionKey },
      { timeoutMs: maxMs },
    );
    call.then(
      (result) => finish(result?.compacted === true ? "compacted" : "failed"),
      (error) =>
        finish(
          working(error)
            ? "busy"
            : error?.answered
              ? "failed"
              : // No answer within maxMs: whether it summarised is unknown.
                error?.code === "TIMEOUT"
                ? "unknown"
                : // The Gateway went away, and its compaction with it.
                  "interrupted",
        ),
    );
    const job = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        if (settled) return;
        answered = true;
        console.warn(
          `Summarising chat ${id} still runs after ${Math.round(answerMs / 1000)} s; the chat stays locked until the Gateway ends it.`,
        );
        this.stops.set(
          id,
          watchCompactEnd({
            client,
            sessionKey,
            pollMs,
            alive: () =>
              !service.closed &&
              service.runtime.client === client &&
              (service.runtime.generationId ?? null) === generation,
            onEnd: finish,
          }),
        );
        resolve({ compacted: false, running: true });
      }, answerMs);
      timer.unref?.();
      call.then(
        (result) => {
          if (answered) return;
          if (result?.compacted !== true) reject(chatProblem("CHAT_COMPACT_NOTHING"));
          else resolve({ compacted: true });
        },
        (error) => {
          if (answered) return;
          if (working(error)) return reject(chatProblem("CHAT_BUSY"));
          // The code and the Gateway's error class only: its text may name host paths.
          console.warn(
            `Summarising chat ${id} failed: ${error?.code || "unknown"}${
              error?.remoteError ? ` (${error.remoteError})` : ""
            }`,
          );
          // The Gateway went away before it answered.
          if (!error?.answered) reject(assistantProblem("unavailable", 503));
          else reject(chatProblem("CHAT_COMPACT_FAILED"));
        },
      );
    });
    // Its refusal reaches the request; a request that went away leaves it unheard.
    job.catch(() => {});
    this.running.set(id, job);
    service.changed({ conversationId: id });
    return job;
  }
  /**
   * How a summary ended after its request had answered that it still runs: "failed",
   * "interrupted" (the Gateway went away) or "unknown" (no end within maxMs); null
   * otherwise. Kept until the next summary or turn of the chat.
   */
  outcome(conversationId) {
    return this.outcomes.get(conversationId) ?? null;
  }
  /** The person moved on: a turn was accepted (conversation-turns.js). */
  settle(conversationId) {
    this.outcomes.delete(conversationId);
  }
  /** Ends every watch at shutdown; the Gateway's own compactions are not touched. */
  close() {
    for (const stop of this.stops.values()) stop();
    this.stops.clear();
  }
  /**
   * Hides the hint of a chat at its current context size, read from the Gateway, until
   * the context grew clearly further (reappearsAt). A session that names no size
   * shows no hint either: nothing is stored then (`dismissed: false`). The size is
   * written under admission, for a chat that still takes turns.
   */
  async dismiss(conversationId) {
    const service = this.service;
    const conversation = service.store.getConversation(conversationId);
    refuseClosedChat(service, conversation);
    service.requireReady();
    let history;
    try {
      history = await service.runtime.client.call("chat.history", {
        sessionKey: conversation.runtimeSessionKey,
        limit: 1,
      });
    } catch (error) {
      if (!error?.answered) throw assistantProblem("unavailable", 503);
      console.warn(
        `Hiding the long-chat hint of chat ${conversationId} failed: ${error.code}`,
      );
      throw chatProblem("CHAT_HINT_FAILED");
    }
    const tokens = history?.sessionInfo?.totalTokens;
    if (!Number.isSafeInteger(tokens) || tokens < 0) return { dismissed: false };
    return service.admit(() => {
      const current = service.store.getConversation(conversationId);
      refuseClosedChat(service, current);
      this.db
        .prepare(
          "INSERT INTO assistant_long_chat_dismissals VALUES(?,?,?,?) ON CONFLICT(conversation_id, person) DO UPDATE SET tokens=excluded.tokens, dismissed_at=excluded.dismissed_at",
        )
        .run(
          conversationId,
          personOf(current),
          tokens,
          new Date(service.now?.() ?? Date.now()).toISOString(),
        );
      service.changed({ conversationId });
      return { dismissed: true };
    });
  }
  /** Whether a summary on request runs in a chat of these agents (any without ids). */
  runningFor(assistantIds) {
    return [...this.running.keys()].some((id) => {
      if (!assistantIds) return true;
      try {
        return assistantIds.has(this.service.store.storedConversation(id).assistantId);
      } catch {
        return false;
      }
    });
  }
  /** A deleted chat's hidden hints go with it (chat-removal.js). */
  forget(conversationId) {
    this.outcomes.delete(conversationId);
    this.db
      .prepare("DELETE FROM assistant_long_chat_dismissals WHERE conversation_id=?")
      .run(conversationId);
  }
}
