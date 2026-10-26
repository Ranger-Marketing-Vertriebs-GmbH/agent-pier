import { randomUUID } from "node:crypto";
import { personalCapabilities } from "./native-capabilities.js";

/**
 * What the agent hears in the memory step: OpenClaw's `sessions.compact` runs no
 * memory flush, so before a summary AgentPier asks the agent itself to keep what it
 * must (AGENTPIER-194). The turn writes only its own memory (memory-write-policy.js
 * memoryStepWrite) with only memory tools (memory-step-tools.js).
 */
export const memoryStepText =
  "AgentPier memory step: this chat is about to be summarised, and the summary drops its details. " +
  "Write what you must keep to your own memory now: lasting facts and decisions to MEMORY.md, " +
  "today's notes to memory/YYYY-MM-DD.md. Store no credentials and no transcripts. " +
  "Do nothing else, then answer in one short line.";
export const memoryStepLimitMs = 5 * 60_000;
// After an abort, how long the step waits for the session's run to end.
const idleLimitMs = 60_000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ended = { completed: null, failed: "failed", cancelled: "interrupted" };
// More open records than steps could ever run at once means some outlived their step.
const keptWrites = 1000;

/**
 * The memory writes the write guard admitted for each memory step's turn
 * (team-bridge.js writeAllowed and memory-write-policy.js flushWrite): a step counts
 * as saved only when its run completed after at least one of them. A completed run
 * says nothing about its writes, all of which the guard may have refused.
 */
export class MemoryStepWrites {
  constructor() {
    this.counts = new Map();
  }
  note(attemptId) {
    if (typeof attemptId !== "string") return;
    if (!this.counts.has(attemptId) && this.counts.size >= keptWrites)
      this.counts.clear();
    this.counts.set(attemptId, (this.counts.get(attemptId) ?? 0) + 1);
  }
  written(attemptId) {
    return (this.counts.get(attemptId) ?? 0) > 0;
  }
  forget(attemptId) {
    this.counts.delete(attemptId);
  }
}

/**
 * The memory step before a summary: a hidden turn of context kind `memory-step`
 * (shown compactly, conversations.js internalKinds), sent only by AgentPier. Its
 * context carries no Telegram origin, so no channel delivers its reply. The step is
 * bounded: past its limit its run is aborted as **Stop** does (service.cancel) and
 * the step ends once the chat has no active run.
 */
export class MemoryStep {
  constructor({
    service,
    limitMs = memoryStepLimitMs,
    pollMs = 500,
    idleMs = idleLimitMs,
  }) {
    this.service = service;
    this.limitMs = limitMs;
    this.pollMs = pollMs;
    this.idleMs = idleMs;
  }
  /**
   * Whether the chat's agent may write its memory: "Remember information" on (a
   * temporary member's from its lead, personalCapabilities) and the write guard
   * proven; a shared agent's step writes its shared memory (as flushWrite).
   */
  eligible(conversation) {
    const { store, config } = this.service;
    let agent;
    try {
      agent = store.getAssistant(conversation.assistantId);
    } catch {
      return false;
    }
    return !!agent && personalCapabilities(agent).memory && !!config?.writeGuard?.();
  }
  /**
   * Runs the step: `{ saved }`, with a `reason` when nothing was saved; a completed
   * run without an admitted memory write is "unwritten".
   */
  async run(conversation) {
    let attemptId;
    try {
      return await this.attempt(conversation, (id) => (attemptId = id));
    } finally {
      this.service.memoryStepWrites?.forget(attemptId);
    }
  }
  async attempt(conversation, track) {
    const { service } = this;
    let attemptId;
    try {
      const sent = await service.send(
        conversation.id,
        { clientRequestId: `memory-step:${randomUUID()}`, text: memoryStepText },
        { kind: "memory-step" },
      );
      attemptId = track(sent.attempt?.id);
    } catch {
      return { saved: false, reason: "refused" };
    }
    if (!attemptId) return { saved: false, reason: "refused" };
    const deadline = Date.now() + this.limitMs;
    while (Date.now() < deadline) {
      const outcome = this.outcome(attemptId);
      if (outcome) return outcome;
      if (service.closed) return { saved: false, reason: "interrupted" };
      await pause(Math.min(this.pollMs, Math.max(deadline - Date.now(), 1)));
    }
    await service.cancel(attemptId).catch(() => {});
    await this.idle(conversation.id);
    // A run that still finished on its own saved what it wrote.
    return this.outcome(attemptId)?.saved
      ? { saved: true }
      : { saved: false, reason: "timeout" };
  }
  outcome(attemptId) {
    const { state } = this.service.ledger.getAttempt(attemptId);
    if (state === "interrupted") return { saved: false, reason: "interrupted" };
    if (!(state in ended)) return null;
    if (ended[state]) return { saved: false, reason: ended[state] };
    return this.service.memoryStepWrites?.written(attemptId)
      ? { saved: true }
      : { saved: false, reason: "unwritten" };
  }
  // Until no attempt of the chat is active (as sendTurn's busy rule), within a bound.
  async idle(conversationId) {
    const { ledger } = this.service;
    const deadline = Date.now() + this.idleMs;
    const active = () =>
      ledger.pending().some((a) => {
        try {
          return ledger.getRequest(a.requestId).conversationId === conversationId;
        } catch {
          return false;
        }
      });
    while (active() && Date.now() < deadline && !this.service.closed)
      await pause(this.pollMs);
  }
}
