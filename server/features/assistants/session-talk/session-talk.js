// A coding session asks or tells an agent something (the session's agent_ask and
// agent_tell tools). The message runs as an ordinary turn in the agent's main chat,
// framed as the session's, not the owner's (variant B: the agent keeps its tools,
// approvals apply as usual). A busy or restarting agent queues it. An ask waits
// up to askWaitMs for the answer; when the call stops waiting first (its deadline,
// or the CLI dropped the call) the answer arrives later in the session as a late
// answer. Every message is logged (TalkStore), limited per pair and audited.
import { serverMessages } from "../../../lib/i18n/de.js";
import { askWaitMs } from "../lead-requests.js";
import { mainConversation } from "../routine-targets.js";
import { TalkStore } from "./talk-store.js";
import { noteLimit, talkBudgetRefusal } from "./talk-budget.js";
import { sessionProjectId, talkAgent, talkAgentsFor, talkVia } from "./talk-reach.js";
import { answerChars, talkPass } from "./talk-dispatch.js";

export const talkTextChars = 8000;
const pruneEveryMs = 60_000;
const messages = serverMessages.sessions;

const talkProblem = (code, status, message, extra = {}) =>
  Object.assign(new Error(message), { code, status, ...extra });
const notFound = () =>
  talkProblem("AGENT_TALK_NOT_FOUND", 404, messages.talkAgentNotFound);
const invalid = () => talkProblem("AGENT_TALK_INVALID", 400, messages.talkInvalid);

// Text the session wrote: not blank, at most 8000 characters, no control
// characters other than line breaks and tabs.
function message(text) {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.length > talkTextChars ||
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)
  )
    throw invalid();
  return text;
}

export class SessionTalk {
  constructor(w) {
    this.w = w;
    // Injectable for tests: the clock and the ask's wait.
    this.now = () => Date.now();
    this.waitMs = askWaitMs;
    this.store = new TalkStore(w.a.store.db, () => this.now());
    // The checks of the asks waiting in this process.
    this.waits = new Set();
    this.closed = false;
    // A process that ended while asks waited, or before a settled one was handed
    // over: nobody holds them any more, so their answers reach the session late.
    for (const row of this.store.unclaimedAsks())
      this.store.patch(row.id, { late: true });
  }
  /** The agents the session may talk to; none for a session that may not talk. */
  async agents(sessionId) {
    const session = await this.session(sessionId);
    return {
      agents: talkAgentsFor(this.w, session).map(({ assistantId, name, via }) => ({
        agentId: assistantId,
        name,
        via,
      })),
    };
  }
  /**
   * Asks the agent and waits for its answer: `answered`, `failed` when its turn
   * ended without one, or `pending` once the wait (from `startedAt`) ended or the
   * caller's `signal` aborted; that answer then arrives in the session later.
   */
  async ask(sessionId, { agentId, question } = {}, { signal, startedAt } = {}) {
    const begun = startedAt ?? this.now();
    const row = await this.accept(sessionId, agentId, question, "ask");
    const agent = { agentId: row.assistantId, name: row.agentName };
    this.tick().catch(() => {});
    const settled = await this.waitFor(row.id, { signal, deadline: begun + this.waitMs });
    // A response that closes before it is written hands the outcome back: it then
    // reaches the session as a late answer (as LeadRequests#undelivered).
    if (settled.inline && signal) {
      const handBack = () => this.undelivered(row.id);
      if (signal.aborted) handBack();
      else signal.addEventListener("abort", handBack, { once: true });
    }
    if (settled.phase === "answered" && settled.inline) {
      const answer = settled.answer ?? "";
      return {
        status: "answered",
        agent,
        answer: answer.slice(0, answerChars),
        truncated: answer.length > answerChars || settled.cut === true,
      };
    }
    if (settled.phase === "failed" && settled.inline)
      return { status: "failed", requestId: row.id, agent, reason: settled.diagnostic };
    return { status: "pending", requestId: row.id, agent };
  }
  /** The caller could not receive an inline outcome: deliver it as a late answer. */
  undelivered(id) {
    try {
      if (!this.store.get(id)?.inline) return;
      this.store.patch(id, { inline: false, late: true });
      this.changed();
      this.tick().catch(() => {});
    } catch {
      /* Pruned meanwhile; nothing to hand back. */
    }
  }
  /** Sends a notice the agent reads in its main chat; its reply is not sent back. */
  async tell(sessionId, { agentId, message: text } = {}) {
    const row = await this.accept(sessionId, agentId, text, "tell");
    this.tick().catch(() => {});
    return {
      status: "queued",
      requestId: row.id,
      agent: { agentId: row.assistantId, name: row.agentName },
    };
  }
  async session(sessionId) {
    if (typeof sessionId !== "string") return null;
    try {
      return await this.w.s.sessions.get(sessionId);
    } catch {
      return null;
    }
  }
  projectName(projectId) {
    if (!projectId) return null;
    try {
      return (
        this.w.s.memory.projects().projects.find((p) => p.id === projectId)?.name ?? null
      );
    } catch {
      return null;
    }
  }
  // Checks the message, the reach and the budget, then records it as queued.
  async accept(sessionId, agentId, text, op) {
    text = message(text);
    if (typeof agentId !== "string" || !agentId) throw notFound();
    const session = await this.session(sessionId);
    const via = session ? talkVia(this.w, agentId, session) : null;
    const agent = via ? talkAgent(this.w, agentId) : null;
    if (!agent) throw notFound();
    const chat = mainConversation(this.w.a.store, agent.id);
    if (!chat) throw talkProblem("AGENT_TALK_UNAVAILABLE", 503, messages.talkUnavailable);
    const projectId = sessionProjectId(session);
    const fields = {
      op,
      direction: "to-agent",
      assistantId: agent.id,
      agentName: agent.name,
      conversationId: chat.id,
      sessionId: session.id,
      sessionCreatedAt: session.createdAt ?? null,
      projectId,
      sessionName: session.name ?? "",
      projectName: this.projectName(projectId),
      tool: session.tool,
      via,
    };
    const refusal = talkBudgetRefusal(this.store, {
      sessionId: session.id,
      assistantId: agent.id,
      now: this.now(),
    });
    if (refusal) {
      noteLimit(this.store, { ...fields, limit: refusal.limit });
      this.audit(fields, { requestId: null, status: "limited" });
      this.changed();
      throw talkProblem(
        "AGENT_TALK_LIMIT",
        429,
        messages.talkLimit(refusal.retryAfterSeconds),
        refusal,
      );
    }
    const row = this.store.create({ ...fields, text, phase: "queued" });
    this.audit(row, { requestId: row.id, status: "queued" });
    this.changed();
    return row;
  }
  /**
   * Holds the ask until its row settles, the deadline passes or `signal` aborts
   * (as LeadRequests#waitFor: published changes, a 1 s tick and the deadline). Only
   * an outcome handed over here is marked inline; otherwise the row becomes late.
   */
  waitFor(id, { signal, deadline }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (row) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(tick);
        unsubscribe();
        signal?.removeEventListener?.("abort", check);
        this.waits.delete(check);
        resolve(row);
      };
      const late = () => {
        const row = this.store.get(id);
        if (!row || row.inline) return finish(row || { id });
        return finish(this.store.patch(id, { late: true }));
      };
      const check = () => {
        if (done) return;
        try {
          const row = this.store.get(id);
          if (!row) return finish({ id });
          if (["answered", "failed"].includes(row.phase) && !row.late)
            return finish(this.store.patch(id, { inline: true }));
          if (this.closed || signal?.aborted || this.now() >= deadline) return late();
        } catch {
          finish({ id });
        }
      };
      const unsubscribe = this.w.a.events?.subscribe?.(() => check()) ?? (() => {});
      // Changes are published, but a missed one must not hold the call to the end.
      const tick = setInterval(check, 1000);
      const timer = setTimeout(check, Math.max(0, deadline - this.now()));
      tick.unref?.();
      timer.unref?.();
      signal?.addEventListener?.("abort", check, { once: true });
      this.waits.add(check);
      check();
    });
  }
  /** One pass: dispatch, observe and settle late answers. A pass under way is joined. */
  tick() {
    if (this.passing) {
      this.again = true;
      return this.passing;
    }
    this.passing = (async () => {
      try {
        do {
          this.again = false;
          if (this.closed) return;
          if (!(this.now() - (this.prunedAt ?? -Infinity) < pruneEveryMs)) {
            this.prunedAt = this.now();
            this.store.prune();
          }
          await talkPass(this);
          for (const check of [...this.waits]) check();
        } while (this.again);
      } finally {
        this.passing = null;
      }
    })();
    return this.passing;
  }
  changed() {
    try {
      this.w.a.changed?.();
    } catch {
      /* The live push follows on the next change. */
    }
  }
  // Ids and enums only (audit-session-talk-details.js); never the text.
  audit(row, { requestId, status }) {
    try {
      this.w.s.audit?.append({
        action: row.op === "ask" ? "session.asked" : "session.told",
        resourceType: "session",
        source: "system",
        outcome: status === "queued" ? "success" : "failure",
        sessionId: row.sessionId,
        projectId: row.projectId,
        details: {
          tool: row.tool,
          sessionTalk: {
            assistantId: row.assistantId,
            op: row.op,
            ...(requestId ? { requestId } : {}),
            via: row.via,
            status,
          },
        },
      });
    } catch (error) {
      console.error("Session talk audit failed:", error?.message);
    }
  }
  async close() {
    this.closed = true;
    for (const check of [...this.waits]) check();
    await this.passing?.catch(() => {});
  }
}
