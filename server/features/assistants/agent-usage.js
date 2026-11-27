import { assistantProblem } from "./assistant-validation.js";
import { runtimeFor } from "./runtimes/runtime-for.js";

// What an agent's sessions used, for the owner: the tokens and, where a price is
// known, the cost. The routes GET /api/assistants/:id/usage (today, 7 and 30 days,
// over all of the agent's sessions) and GET /api/assistant-conversations/:id/usage
// (one chat since it began, with its context fill) read the usage the agent's
// runtime recorded, through the port (agent-runtime.js agents.usage and
// sessions.usage); AgentPier keeps no ledger of its own. Only a runtime with the
// `usage` capability has figures (OpenClaw).
//
// Reads are kept for a while per agent and per chat, and a read in flight is shared,
// so an open page and its live topic cost the runtime one report (live-topics.js
// `agent.usage` and `agent.chat-usage`). A run that ended in a chat of the agent
// drops both, and its topics read again. Figures the runtime was still computing
// (`pending`) are kept only briefly.
//
// Who reads them: the owner. A user's chat has no usage line for him, also under her
// opt-in (its figures would count turns from before it); a user sees none at all
// (docs/agents.md).

/** The periods of an agent's usage, each the last `days` calendar days. */
export const usagePeriods = Object.freeze([
  Object.freeze({ id: "today", days: 1 }),
  Object.freeze({ id: "week", days: 7 }),
  Object.freeze({ id: "month", days: 30 }),
]);
/** How long a read is kept, and one whose figures were still being computed. */
export const usageCacheMs = 60000;
export const usagePendingMs = 2000;
const maxEntries = 500;

/** The usage reads of `assistants` (the AssistantService), or the routes' 404. */
export function usageOf(assistants) {
  if (!assistants?.usage) throw assistantProblem("notFound", 404);
  return assistants.usage;
}

export class AgentUsage {
  #entries = new Map();
  /**
   * `assistants` is the AssistantService. `runtimeOf(agent)` replaces the agent's
   * runtime and `now` the clock (tests).
   */
  constructor(assistants, { now, runtimeOf } = {}) {
    this.assistants = assistants;
    this.now = now || (() => assistants.now?.() ?? Date.now());
    this.runtimeOf = runtimeOf || ((agent) => runtimeFor(agent, assistants.runtime));
  }
  // The agent's runtime with usage figures, or the route's 404 without them.
  #runtime(agent) {
    const runtime = this.runtimeOf(agent);
    if (!runtime.capabilities().usage?.available) throw assistantProblem("notFound", 404);
    if (this.assistants.maintenance) throw assistantProblem("unavailable", 503);
    this.assistants.requireReady(agent);
    return runtime;
  }
  // One read per key while it is kept; a failed one is forgotten at once.
  #kept(key, read) {
    const at = this.now();
    const entry = this.#entries.get(key);
    if (entry && at - entry.at < entry.ttl) return entry.value;
    const fresh = { at, ttl: usageCacheMs, value: null };
    fresh.value = read().then(
      (value) => {
        if (value.pending) fresh.ttl = usagePendingMs;
        return value;
      },
      (error) => {
        if (this.#entries.get(key) === fresh) this.#entries.delete(key);
        // The port's own refusal says nothing the owner can act on.
        throw error?.key ? error : assistantProblem("unavailable", 503);
      },
    );
    this.#entries.delete(key);
    this.#entries.set(key, fresh);
    if (this.#entries.size > maxEntries)
      this.#entries.delete(this.#entries.keys().next().value);
    return fresh.value;
  }
  /**
   * Agent `id`'s usage: `{ periods: [{ id, days, from, to, tokens, cost, pending }],
   * daily, pending, updatedAt }`, one period per usagePeriods; `daily` the tokens of
   * each of the last 30 days. 404 for an unknown agent or a runtime without figures.
   */
  async agent(id) {
    const agent = this.assistants.store.getAssistant(id);
    const runtime = this.#runtime(agent);
    return this.#kept(`agent:${agent.id}`, async () => {
      const now = this.now();
      const reads = await Promise.all(
        usagePeriods.map(({ days }) =>
          runtime.agents.usage({ agentId: agent.runtimeAgentId, days, now }),
        ),
      );
      const periods = usagePeriods.map(({ id, days }, index) => {
        const { from, to, tokens, cost, pending } = reads[index];
        return { id, days, from, to, tokens, cost, pending: pending === true };
      });
      return {
        periods,
        daily: reads.at(-1).daily || [],
        pending: periods.some((period) => period.pending),
        updatedAt: new Date(now).toISOString(),
      };
    });
  }
  /**
   * The usage of the owner's chat `conversationId` since it began: `{ tokens, cost,
   * pending, context, updatedAt }`. 404 for an unknown or deleted chat, a user's
   * chat, a chat without a session yet and a runtime without figures.
   */
  async chat(conversationId) {
    const conversation = this.assistants.store.getConversation(conversationId);
    if (typeof conversation.userId === "string" || !conversation.runtimeSessionKey)
      throw assistantProblem("notFound", 404);
    const agent = this.assistants.store.getAssistant(conversation.assistantId);
    const runtime = this.#runtime(agent);
    const key = conversation.runtimeSessionKey;
    return this.#kept(`chat:${conversation.id}:${key}`, async () => {
      const { tokens, cost, pending, context } = await runtime.sessions.usage({ key });
      return {
        tokens,
        cost,
        pending: pending === true,
        context: context ?? null,
        updatedAt: new Date(this.now()).toISOString(),
      };
    });
  }
  /**
   * A run of `conversation` ended: its figures and its agent's are read anew.
   * Returns whether anything was kept for them.
   */
  changed(conversation) {
    let dropped = false;
    for (const key of [...this.#entries.keys()])
      if (
        key === `agent:${conversation.assistantId}` ||
        key.startsWith(`chat:${conversation.id}:`)
      )
        dropped = this.#entries.delete(key) || dropped;
    return dropped;
  }
}
