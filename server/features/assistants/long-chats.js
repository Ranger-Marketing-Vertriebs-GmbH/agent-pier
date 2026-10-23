import { chatBusy, chatProblem } from "./agent-chats.js";
import { assistantProblem } from "./assistant-validation.js";
import { refuseClosedChat } from "./conversation-turns.js";
import { dispatchQueued } from "./queued-dispatch.js";
import { MemoryStep } from "./memory-step.js";
import {
  answerCodeOf,
  compactOutcome,
  kindOf,
  readBaseline,
  reasonOf,
  watchMarker,
} from "./compaction-watch.js";

// OpenClaw 2026.10.3 `sessions.compact` {key} summarises a session's history with the
// session's own model (trigger "manual", sessions-compaction-runner) and answers once
// it is done: { ok, compacted, reason, result }. It refuses a session with an active
// run or queued work (INVALID_REQUEST) and answers `compacted: false` when there is
// nothing to summarise. Unlike the compaction before a run, it never runs the
// pre-compaction memory flush (agent-runner-memory), so AgentPier runs its own memory
// step first where the agent may write its memory (memory-step.js). A large
// history takes long: the request answers after `answerMs` that it still runs, the
// chat stays compacting until the Gateway ended it, at most `maxMs` (compactions.js).
// After a dropped call it waits for a new compaction marker for `lostMs` at most
// (compaction-watch.js).
export const compactTiming = {
  answerMs: 10 * 60000,
  maxMs: 60 * 60000,
  lostMs: 10 * 60000,
  pollMs: 30000,
};
// The runtime states in which the Gateway that runs a summary may still finish it.
const runningStates = new Set(["ready", "reconnecting"]);
// What the request answers for an outcome it still reports.
const answerOf = {
  compacted: () => ({ compacted: true }),
  nothing: () => Promise.reject(chatProblem("CHAT_COMPACT_NOTHING")),
  busy: () => Promise.reject(chatProblem("CHAT_BUSY")),
  failed: () => Promise.reject(chatProblem("CHAT_COMPACT_FAILED")),
  // The Gateway went away before it answered.
  interrupted: () => Promise.reject(assistantProblem("unavailable", 503)),
  unknown: () => Promise.reject(assistantProblem("unavailable", 503)),
};
// A hidden hint shows again once the context grew by half, or by this many tokens,
// over the size it had when it was hidden, whichever comes first.
export const dismissedGrowthTokens = 50000;

/** The context size from which a hint hidden at `tokens` shows again. */
export const reappearsAt = (tokens) =>
  tokens + Math.min(Math.round(tokens / 2), dismissedGrowthTokens);

/** The table of hidden hints, per chat and person (private: operations/private-tables.js). */
export const dismissalTable =
  "CREATE TABLE IF NOT EXISTS assistant_long_chat_dismissals (conversation_id TEXT NOT NULL, person TEXT NOT NULL, tokens INTEGER NOT NULL, dismissed_at TEXT NOT NULL, PRIMARY KEY(conversation_id, person))";

// Whether a turn of the chat is still unresolved (as sendTurn's busy rule).
const activeTurn = (service, conversationId) =>
  service.ledger.pending().some((attempt) => {
    try {
      return (
        service.ledger.getRequest(attempt.requestId).conversationId === conversationId
      );
    } catch {
      return false;
    }
  });

// Whose chat it is: a user's own, or the owner's.
const personOf = (conversation) =>
  typeof conversation.userId === "string" ? conversation.userId : "owner";

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
    // Chats whose memory step runs before their summary, and those whose step saved
    // nothing, with when their summary ended.
    this.saving = new Set();
    this.unsaved = new Map();
    this.memoryStep = new MemoryStep({ service });
    this.timing = { ...compactTiming };
    this.db = service.store.db;
    this.db.exec(dismissalTable);
  }
  /** Whether the chat's history is being summarised on request now. */
  compacting(conversationId) {
    return this.running.has(conversationId);
  }
  /** What the chat's summary does now: "memory" (its memory step), true or false. */
  phase(conversationId) {
    return this.saving.has(conversationId) ? "memory" : this.running.has(conversationId);
  }
  /** Whether the chat's memory step runs, the one turn its summary lets through. */
  savingMemory(conversationId) {
    return this.saving.has(conversationId);
  }
  /** Whether the chat's last summary ran without its memory step having saved. */
  memoryNotSaved(conversationId) {
    return this.unsaved.has(conversationId);
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
   * double click compacts once, also while its memory step runs. Refused while a turn
   * runs, a message waits or team work reports into the chat, and for a chat that
   * takes no turns.
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
      job = this.start(conversation);
    });
    return job;
  }
  /**
   * Where the agent may write its memory, the memory step runs first (memory-step.js):
   * the chat is summarising meanwhile, so a message waits and a second request joins,
   * but shows that memories are saved. Whatever the step's end, the summary follows;
   * one that saved nothing leaves the chat's notice (memoryNotSaved). A Gateway that
   * is not ready after the step, or a run of the step that a timeout could not end,
   * ends the summary with its refusal instead.
   */
  start(conversation) {
    const id = conversation.id;
    if (!this.memoryStep.eligible(conversation)) return this.compact(conversation);
    const service = this.service;
    this.outcomes.delete(id);
    this.unsaved.delete(id);
    this.saving.add(id);
    let stopped = false;
    const job = this.memoryStep
      .run(conversation)
      .catch(() => ({ saved: false }))
      .then((step) => {
        this.saving.delete(id);
        if (stopped) throw assistantProblem("notFound", 404);
        const memoryNotSaved = !step.saved;
        let current;
        try {
          current = service.store.getConversation(id);
          refuseClosedChat(service, current);
          service.requireReady();
          if (activeTurn(service, id)) throw chatProblem("CHAT_BUSY");
        } catch (refusal) {
          this.stops.delete(id);
          this.running.delete(id);
          if (memoryNotSaved) this.unsaved.set(id, service.now?.() ?? Date.now());
          service.changed({ conversationId: id });
          if (!service.closed) dispatchQueued(service, id).catch(() => {});
          throw refusal;
        }
        return this.compact(current, { memoryNotSaved });
      });
    job.catch(() => {});
    // Shutdown or a deleted chat: the summary ends after the step without a notice.
    this.stops.set(id, () => {
      stopped = true;
      this.saving.delete(id);
      this.stops.delete(id);
      this.running.delete(id);
    });
    this.running.set(id, job);
    service.changed({ conversationId: id });
    return job;
  }
  /**
   * Holds the chat busy until the Gateway ended the compaction; admission is not held
   * meanwhile. The `sessions.compact` call stays open up to `maxMs`: its answer is the
   * end, whatever it was. The request answers after `answerMs` at the latest that it
   * still runs (OpenClaw holds the session's lifecycle lock meanwhile, so a send would
   * only wait for it). A dropped connection to a Gateway that still runs loses only
   * the call: a new compaction marker then ends it, for `lostMs` at most
   * (compaction-watch.js). A Gateway that is gone or stopping ends it at once. An end
   * the request no longer reported is the chat's notice (outcome).
   */
  compact(conversation, { memoryNotSaved = false } = {}) {
    const service = this.service;
    const id = conversation.id;
    const sessionKey = conversation.runtimeSessionKey;
    const client = service.runtime.client;
    const generation = service.runtime.generationId ?? null;
    const { answerMs, maxMs, lostMs, pollMs } = this.timing;
    const since = service.now?.() ?? Date.now();
    const alive = () =>
      !service.closed &&
      service.runtime.client === client &&
      (service.runtime.generationId ?? null) === generation &&
      runningStates.has(service.runtime.status?.().availability);
    const warned = new Set();
    // Once per step and kind of failure: another failure of the step still shows.
    const warn = (what, error) => {
      const key = `${what}\u0000${kindOf(error)}`;
      if (warned.has(key)) return;
      warned.add(key);
      console.warn(`Summarising chat ${id}: ${what} failed: ${reasonOf(error)}`);
    };
    // Every callback of the run: a throw is logged, never left unhandled.
    const guard =
      (fn) =>
      (...args) => {
        try {
          return fn(...args);
        } catch (error) {
          warn("handling its end", error);
        }
      };
    this.outcomes.delete(id);
    let answered = false;
    let settled = false;
    let answer;
    const timers = [];
    let stopWatch = () => {};
    const stop = () => {
      for (const timer of timers) clearTimeout(timer);
      stopWatch();
    };
    const later = (fn, ms) => {
      const timer = setTimeout(guard(fn), ms);
      timer.unref?.();
      timers.push(timer);
    };
    const end = () => {
      settled = true;
      stop();
      this.stops.delete(id);
      this.running.delete(id);
    };
    const finish = (outcome, error) => {
      if (settled) return;
      end();
      if (!answered) {
        answered = true;
        Promise.resolve()
          .then(answerOf[outcome] || answerOf.failed)
          .then(answer.resolve, answer.reject);
      } else if (outcome !== "compacted") {
        console.warn(
          `Summarising chat ${id} ended after its request: ${outcome}${error ? ` ${reasonOf(error)}` : ""}`,
        );
        this.outcomes.set(id, { outcome, at: service.now?.() ?? Date.now() });
      }
      try {
        if (memoryNotSaved) this.unsaved.set(id, service.now?.() ?? Date.now());
        // A hint hidden before measured the history that is summarised now.
        if (outcome === "compacted") this.unhide(id, personOf(conversation));
        service.changed({ conversationId: id });
      } catch (failure) {
        warn("recording its end", failure);
      }
      // A message queued meanwhile goes out now, once (queued-dispatch.js).
      if (!service.closed)
        Promise.resolve()
          .then(() => dispatchQueued(service, id))
          .catch((failure) => warn("sending the queued message", failure));
    };
    // The request answers that it runs.
    const goOn = () => {
      if (settled || answered) return;
      answered = true;
      console.warn(
        `Summarising chat ${id} still runs; the chat stays locked until the Gateway ends it.`,
      );
      answer.resolve({ compacted: false, running: true });
    };
    // Reads the newest marker first, so a later one shows the summary's success.
    const baseline = readBaseline(client, sessionKey, warn);
    const lost = guard((error) => {
      // The code only, never the text.
      console.warn(`Summarising chat ${id}: the call failed: ${reasonOf(error)}`);
      if (!alive()) return finish("interrupted", error);
      goOn();
      later(() => finish("unknown"), lostMs);
      baseline.then(
        guard((before) => {
          if (settled) return;
          stopWatch = watchMarker({
            client,
            sessionKey,
            pollMs,
            baseline: before,
            since,
            alive,
            onEnd: guard((outcome) => finish(outcome)),
            warn,
          });
        }),
      );
    });
    const job = new Promise((resolve, reject) => {
      answer = { resolve, reject };
    });
    later(goOn, answerMs);
    // The upper bound, also when the client's own timeout never fires.
    later(() => finish("unknown"), maxMs);
    baseline
      .then(() =>
        client.call("sessions.compact", { key: sessionKey }, { timeoutMs: maxMs }),
      )
      .then(
        guard((result) => {
          const outcome = compactOutcome({ result });
          // An answered `ok: false`: its code, never its reason text.
          const failure =
            result?.ok === false && outcome !== "nothing"
              ? { code: answerCodeOf(result) }
              : undefined;
          if (!answered && outcome === "failed")
            console.warn(`Summarising chat ${id} failed: ${reasonOf(failure)}`);
          finish(outcome, failure);
        }),
        guard((error) => {
          const outcome = compactOutcome({ error });
          if (outcome === "lost") return lost(error);
          // The code and the Gateway's error class only.
          if (!answered && outcome !== "busy")
            console.warn(`Summarising chat ${id} failed: ${reasonOf(error)}`);
          finish(outcome, error);
        }),
      );
    // Its refusal reaches the request; a request that went away leaves it unheard.
    job.catch(() => {});
    // Shutdown or a deleted chat: the run ends without a notice or a dispatch.
    this.stops.set(id, () => {
      if (settled) return;
      end();
      if (!answered) {
        answered = true;
        answer.reject(assistantProblem("notFound", 404));
      }
    });
    this.running.set(id, job);
    service.changed({ conversationId: id });
    return job;
  }
  /**
   * How a summary ended after its request had answered that it still runs: "nothing"
   * (nothing was left to summarise), "busy" (refused: the session had work),
   * "failed", "interrupted" (the Gateway went away or stopped) or "unknown" (no end
   * within the bound); null otherwise.
   */
  outcome(conversationId) {
    return this.outcomes.get(conversationId)?.outcome ?? null;
  }
  /**
   * A turn written at `writtenAt` (ms) started (conversation-turns.js). The notice
   * stays for a message written before it showed, such as one queued during the
   * summary, and goes once the person writes after it, or with the next summary.
   */
  settle(conversationId, writtenAt) {
    const entry = this.outcomes.get(conversationId);
    if (entry && !(writtenAt < entry.at)) this.outcomes.delete(conversationId);
    const unsaved = this.unsaved.get(conversationId);
    if (unsaved !== undefined && !(writtenAt < unsaved))
      this.unsaved.delete(conversationId);
  }
  /** Ends every summary's run at shutdown; the Gateway's own work is not touched. */
  close() {
    for (const stop of [...this.stops.values()]) stop();
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
  /**
   * A deleted chat's hidden hints go with it (chat-removal.js), and so does a summary
   * still running for it: its end records nothing and its watch stops.
   */
  forget(conversationId) {
    this.stops.get(conversationId)?.();
    this.outcomes.delete(conversationId);
    this.unsaved.delete(conversationId);
    this.db
      .prepare("DELETE FROM assistant_long_chat_dismissals WHERE conversation_id=?")
      .run(conversationId);
  }
}
