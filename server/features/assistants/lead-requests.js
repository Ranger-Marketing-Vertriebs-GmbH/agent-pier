import { assistantProblem } from "./assistant-validation.js";
import { memoryTarget } from "./lead-request-writes.js";
import {
  callerOf,
  LeadRequestStore,
  publicRequest,
  requestTerminal,
  taskWritable,
} from "./lead-request-store.js";
import { excerpt, followUp, memberPrompt, toolResult } from "./lead-request-text.js";
import { ownerTelegram } from "./team-coding.js";
import { runReply } from "./history-text.js";
import { saveText, shortForm } from "./team-texts.js";
import { deliverRequest } from "./lead-request-delivery.js";
import { applyTaskShare, taskShare } from "./lead-share-input.js";
// How long the ask tool holds the lead's turn for an answer. AgentPier runs agents
// on OpenClaw's embedded harness, where a plugin tool call has no own timeout; its
// stuck-session diagnostics only flag a call as long-running after two minutes, so
// the wait ends before that. The plugin's fetch allows a little more.
export const askWaitMs = 110_000;
const ended = new Set(["completed", "failed", "cancelled"]);
const dispatchAttempts = 5;
// A follow-up stays well inside the ledger's text limit; pruning runs about once a minute.
const pruneEveryMs = 60000;
/**
 * Lead agents ask their own members and delegate tasks to permanent ones. Requests
 * wait until the member is free, run as ordinary turns in the member's chat and
 * reach the lead either as the ask tool's result or as a follow-up turn.
 */
export class LeadRequests {
  constructor({ teams, service }) {
    this.teams = teams;
    this.service = service;
    this.store = new LeadRequestStore(teams);
    // Each waiting ask's stop, by the request it waits for.
    this.waits = new Map();
    this.waitMs = askWaitMs;
    // A claim whose send never confirmed returns to the queue; a re-dispatch adopts
    // the ledger request by its stable client id instead of sending twice.
    for (const r of this.store.list())
      if (r.phase === "dispatching") teams.write(r, { phase: "queued" });
  }
  get assistants() {
    return this.service.assistants;
  }
  /** Summaries for the browser. */
  list(parentId) {
    return this.store.list(parentId).map((r) => publicRequest(r));
  }
  /** One request with its whole text and answer. */
  detail(id) {
    const r = this.store.get(id);
    return publicRequest({ ...r, answer: this.store.answer(r) }, { full: true });
  }
  /** A lead's members that are not archived, each with its own agent profile. */
  reachable(leadId) {
    return this.teams
      .members()
      .filter((m) => m.parentAssistantId === leadId && !m.archivedAt)
      .flatMap((m) => {
        const a = this.assistants.store.getAssistant(m.assistantId);
        return a.archivedAt ? [] : [{ m, a }];
      });
  }
  /**
   * What a lead's instructions name of its team (team-guidance.js): the owner's
   * team usage level and its members. No busy state: it would rewrite the
   * instructions whenever a member starts or ends a turn.
   */
  roster(leadId) {
    return {
      usage: this.teams.policy(leadId).usage,
      members: this.reachable(leadId).map(({ m, a }) => ({
        name: a.name,
        role: m.role,
        lifetime: m.lifetime,
      })),
    };
  }
  // --- lead tools -------------------------------------------------------------
  members(inv, input) {
    if (input && Object.keys(input).length) throw assistantProblem("invalid");
    inv.assertCurrent();
    const { lead } = this.store.caller(callerOf(inv));
    const requests = this.store.list(lead.id);
    return {
      members: this.reachable(lead.id).map(({ m, a }) => ({
        memberId: m.id,
        name: a.name,
        role: m.role,
        lifetime: m.lifetime,
        phase: m.phase,
        busy: this.teams.activeMember(m),
        canDelegate: m.lifetime === "permanent",
        requests: requests
          .filter((r) => r.memberId === m.id)
          .slice(-5)
          .map((r) => ({
            requestId: r.id,
            type: r.type,
            phase: r.phase,
            ...(r.fromName ? { from: r.fromName } : {}),
            text: excerpt(r.text, 300),
            ...(r.answer ? { answer: excerpt(r.answer, 2000) } : {}),
          })),
      })),
    };
  }
  async ask(inv, input) {
    const r = await this.create("question", inv, input);
    const answered = await this.waitFor(r.id, inv, this.waitMs);
    return this.toolResult(answered);
  }
  /**
   * A task, optionally with `access` the lead shares for this task only
   * (lead-shares.js): checked against the lead before the task exists, in place
   * before the member's turn starts, gone when the task ends.
   */
  async delegate(inv, input) {
    let share = null;
    if (
      input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      "access" in input
    ) {
      const { access, ...task } = input;
      share = this.taskShare(inv, task.memberId, access);
      input = task;
    }
    return this.toolResult(await this.create("task", inv, input, share));
  }
  taskShare(inv, memberId, access) {
    inv.assertCurrent();
    const { lead } = this.store.caller(callerOf(inv));
    return taskShare(this.assistants.workflows, lead, this.teams.find(memberId), access);
  }
  /**
   * The lead's last reply before this turn, as the Gateway's history serves it: a
   * claimed owner yes proves a task only when this reply offered that member
   * (lead-request-store.js). Null when it cannot be read or is not needed.
   */
  async lastReply(inv, input) {
    if (input?.ownerRequested !== true) return null;
    try {
      const { attempt, conversation, lead } = this.store.lead(inv.attemptId);
      if (this.teams.policy(lead.id).usage === "onRequest") return null;
      const history = await this.assistants.history(conversation.id);
      if (history.stale) return null;
      const current = [attempt.id, attempt.runtimeRunId];
      const reply = history.messages
        .filter((m) => m.role === "assistant" && m.runId && !current.includes(m.runId))
        .at(-1);
      return typeof reply?.text === "string" ? reply.text : null;
    } catch {
      return null;
    }
  }
  async create(type, inv, input, share = null) {
    inv.assertCurrent();
    const offer = type === "task" ? await this.lastReply(inv, input) : null;
    inv.assertCurrent();
    const r = this.store.create({
      type,
      ...callerOf(inv),
      operationId: inv.toolCallId,
      input,
      offer,
    });
    if (share && !requestTerminal.has(r.phase)) applyTaskShare(share, r, inv);
    return this.started(r);
  }
  /** A new request: dispatched at once, briefly; the wait counts from the tool call. */
  async started(r) {
    this.assistants.changed();
    if (r.phase === "queued")
      await Promise.race([
        this.serialized(() => this.dispatch(r.id)).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 5000).unref?.()),
      ]);
    return this.store.get(r.id);
  }
  async cancel(inv, input) {
    if (
      !input ||
      Object.keys(input).some((k) => k !== "requestId") ||
      typeof input.requestId !== "string"
    )
      throw assistantProblem("invalid");
    inv.assertCurrent();
    const { lead } = this.store.lead(inv.attemptId);
    const r = this.store.teams.find(input.requestId);
    if (!r || r.kind !== "lead-request" || r.parentAssistantId !== lead.id)
      throw assistantProblem("notFound", 404);
    return this.toolResult(await this.stop(r.id, "lead"));
  }
  async archive(inv, input) {
    if (!input || Object.keys(input).some((k) => k !== "memberIds"))
      throw assistantProblem("invalid");
    inv.assertCurrent();
    const { lead } = this.store.lead(inv.attemptId);
    const members = this.store.archivable(lead.id, input.memberIds);
    const archived = [];
    for (const m of members) {
      inv.assertCurrent();
      // The revision checked above, and the checks again inside the archiving
      // transaction: a member promoted or asked meanwhile is not archived.
      await this.service.lifecycle("archive", m.id, m.revision, () =>
        this.store.assertArchivable(lead.id, m.id),
      );
      archived.push(m.id);
    }
    return { archived };
  }
  toolResult(r) {
    return toolResult(r, () => this.store.answer(r));
  }
  /**
   * Holds the ask tool's call until the answer arrives, the wait budget ends or the
   * lead's turn is no longer current. Only a completed answer handed over here is
   * marked inline; everything else reaches the lead as a follow-up.
   */
  waitFor(id, inv, budget = askWaitMs) {
    // One deadline, counted from the moment the bridge received the call; the
    // plugin gives up 15 seconds after it.
    const deadline = (inv.startedAt ?? Date.now()) + budget;
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(tick);
        unsubscribe();
        this.waits.delete(stop);
        resolve(value);
      };
      const stop = () => finish(this.store.teams.find(id) || { id });
      const check = () => {
        if (done) return;
        let r;
        try {
          inv.assertCurrent();
          r = this.store.get(id);
        } catch {
          return stop();
        }
        if (Date.now() >= deadline) return finish(r);
        if (r.phase === "completed" && !r.delivery)
          try {
            const inline = this.teams.write(r, { delivery: "inline", settled: true });
            // A response that never reaches the lead hands the answer back to the
            // follow-up path instead of losing it.
            inv.undelivered = () => this.undelivered(id);
            return finish(inline);
          } catch {
            return finish(this.store.get(id));
          }
        if (requestTerminal.has(r.phase)) return finish(r);
      };
      const unsubscribe = this.assistants.events.subscribe(() => check());
      // Changes are published, but a missed one must not hold the turn to the end.
      const tick = setInterval(check, 1000);
      const timer = setTimeout(check, Math.max(0, deadline - Date.now()));
      tick.unref?.();
      timer.unref?.();
      this.waits.set(stop, id);
      check();
    });
  }
  /** The bridge could not hand an inline answer over: deliver it as a follow-up. */
  undelivered(id) {
    try {
      const r = this.store.get(id);
      if (r.delivery === "inline")
        this.teams.write(r, { delivery: null, settled: false });
      this.assistants.changed();
    } catch {
      /* Removed or changed meanwhile; nothing to hand back. */
    }
  }
  /**
   * Whether a native write in a member turn is this task's own, owner-proven work,
   * a task an autonomous lead started in the owner's turn, or one a routine the
   * owner marked "May write" started (taskWritable, lead-request-store.js).
   * Questions, every other task, cancelled or uncertain runs never write; the
   * member's memory stays read-only so a task cannot plant instructions for the
   * owner's own chats.
   */
  mayWrite(requestId, attemptId, assistantId, target) {
    const r = typeof requestId === "string" ? this.store.teams.find(requestId) : null;
    if (
      !taskWritable(r) ||
      r.phase !== "running" ||
      r.attemptId !== attemptId ||
      r.memberAssistantId !== assistantId ||
      typeof target !== "string"
    )
      return false;
    try {
      if (this.assistants.store.getAssistant(r.parentAssistantId).archivedAt)
        return false;
      if (this.teams.member(r.memberId).archivedAt) return false;
    } catch {
      return false;
    }
    let agentId;
    try {
      agentId = this.assistants.store.getAssistant(r.memberAssistantId).runtimeAgentId;
    } catch {
      return false;
    }
    return !memoryTarget(this.assistants.runtime?.paths?.workspaces, agentId, target);
  }
  // A refused change while the lead handles a result (LeadRequestStore.refusedChange).
  refusedChange(requestId) {
    if (this.store.refusedChange(requestId)) this.assistants.changed();
  }
  // --- owner actions ------------------------------------------------------------
  /** Ends an open request; a running member turn is aborted, not abandoned. */
  async stop(id, by = "owner") {
    let r = this.store.get(id);
    if (requestTerminal.has(r.phase)) return r;
    if (r.phase === "queued")
      r = this.teams.write(r, {
        phase: "cancelled",
        cancelledBy: by,
        finishedAt: new Date().toISOString(),
        ...(by === "lead" ? { delivery: "skipped", settled: true } : { delivery: null }),
      });
    else {
      r = this.teams.write(r, { cancelRequested: true, cancelledBy: by });
      if (r.attemptId)
        try {
          await this.assistants.cancel(r.attemptId);
        } catch {
          /* Observed until the runtime confirms the end. */
        }
    }
    this.assistants.changed();
    return this.store.get(id);
  }
  // --- scheduling ---------------------------------------------------------------
  /** One pass: dispatch, observe and deliver. Serialized; the team tick calls it. */
  advance() {
    return this.serialized(() => this.pass());
  }
  /** Runs `operation` after every earlier pass or dispatch has settled. */
  serialized(operation) {
    const run = (this.running || Promise.resolve()).catch(() => {}).then(operation);
    const tracked = run
      .finally(() => {
        if (this.running === tracked) this.running = null;
      })
      .catch(() => {});
    this.running = tracked;
    return run;
  }
  async pass() {
    const a = this.assistants;
    if (this.closed || !a.runtime.client?.ready) return;
    if (!(Date.now() - (this.prunedAt || 0) < pruneEveryMs)) {
      this.prunedAt = Date.now();
      if (this.store.prune()) a.changed();
    }
    let failure;
    // Only open or undelivered requests; settled history is never read here.
    for (const r of this.store.pending()) {
      if (this.closed) return;
      const before = r.revision;
      try {
        if (r.phase === "queued" || r.phase === "dispatching") await this.dispatch(r.id);
        else if (["running", "uncertain"].includes(r.phase)) await this.observe(r.id);
        if (requestTerminal.has(this.store.get(r.id).phase)) await this.deliver(r.id);
      } catch (error) {
        // One unreadable request must not hold back the others.
        if (error?.status !== 409) failure ??= error;
      }
      // A waiting ask and the browser learn of every step at once.
      if (this.store.teams.find(r.id)?.revision !== before) a.changed();
    }
    if (failure) throw failure;
  }
  async dispatch(id) {
    const a = this.assistants;
    let r = this.store.get(id);
    const fail = (diagnostic, phase = "failed") =>
      this.teams.write(this.store.get(id), {
        phase,
        diagnostic,
        finishedAt: new Date().toISOString(),
      });
    const member = this.teams.find(r.memberId);
    const lead = a.store.getAssistant(r.parentAssistantId);
    if (lead.archivedAt) return fail("PARENT_ARCHIVED", "cancelled");
    if (
      !member ||
      member.archivedAt ||
      a.store.getAssistant(r.memberAssistantId).archivedAt
    )
      return fail("MEMBER_ARCHIVED");
    if (r.cancelRequested) return fail(null, "cancelled");
    const key = `lead-request:${id}`;
    const existing = a.ledger
      .requests(member.conversationId)
      .find((x) => x.clientRequestId === key);
    if (!existing) {
      // One request per member at a time, and never while the member works on
      // anything else: an owner turn, its team assignment or another request.
      if (
        this.store
          .open((x) => x.memberId === r.memberId && x.id !== id)
          .some((x) => ["dispatching", "running", "uncertain"].includes(x.phase)) ||
        this.teams.activeMember(member) ||
        this.store
          .open((x) => x.memberId === r.memberId && x.phase === "queued")
          .find((x) => x.id !== id && x.createdAt < r.createdAt)
      )
        return r;
      // A summary its lead asked for after the task comes first (member-summaries.js).
      if (await this.service.memberSummaries?.before(member)) return r;
    }
    r = this.teams.write(r, { phase: "dispatching" });
    // A finished task member works again: its granted MCP servers are bound now and
    // reach the Gateway with the scheduler's next patch (team-mcp.js), never waited for here,
    // because a lead's turn may hold the admission lock while it asks.
    if (ended.has(member.phase)) this.service.mcp?.sync();
    try {
      const sent = await a.send(
        member.conversationId,
        { clientRequestId: key, text: memberPrompt(r) },
        {
          kind: "lead-request",
          requestId: id,
          leadAssistantId: r.parentAssistantId,
          leadName: r.leadName,
          display: r.text,
          ...(r.fromMemberId ? { peer: true, fromName: r.fromName } : {}),
          ...(ownerTelegram(r.origin) ? { telegram: ownerTelegram(r.origin) } : {}),
        },
      );
      const next = this.teams.write(this.store.get(id), {
        phase: ["uncertain", "interrupted"].includes(sent.attempt.state)
          ? "uncertain"
          : "running",
        attemptId: sent.attempt.id,
        startedAt: new Date().toISOString(),
      });
      // A cancel that arrived while the send was in flight aborts the new turn.
      if (next.cancelRequested) await a.cancel(sent.attempt.id).catch(() => {});
      return next;
    } catch (error) {
      const current = this.store.get(id);
      const failures = (current.dispatchFailures || 0) + 1;
      // Busy or unavailable: the request waits for the next pass.
      if ([409, 503].includes(error?.status) || failures < dispatchAttempts)
        return this.teams.write(current, {
          phase: "queued",
          dispatchFailures: [409, 503].includes(error?.status)
            ? current.dispatchFailures
            : failures,
        });
      return fail("DISPATCH_FAILED");
    }
  }
  async observe(id) {
    const a = this.assistants;
    let r = this.store.get(id);
    const attempt = a.ledger.getAttempt(r.attemptId);
    const finish = (patch) =>
      this.teams.write(this.store.get(id), {
        finishedAt: new Date().toISOString(),
        ...patch,
      });
    if (attempt.state === "completed") {
      const chat = this.teams.member(r.memberId).conversationId;
      const history = await a.history(chat);
      if (history.stale) return r;
      // Up to the history limit; beyond it the answer is marked cut, and the whole
      // text stays in the member's chat.
      const reply = await runReply(a, chat, history.messages, attempt);
      // The record keeps an excerpt; a longer answer gets its own row.
      const short = shortForm(reply.text);
      if (short.truncated) saveText(this.teams.db, id, "answer", reply.text);
      return finish({
        phase: "completed",
        answer: short.text,
        ...(short.truncated ? { answerTruncated: true } : {}),
        ...(reply.cut ? { answerCut: true } : {}),
        // A cut answer has text, only not here (OpenClaw's "message too large").
        ...(reply.text.trim() || reply.cut ? {} : { diagnostic: "NO_TEXT" }),
      });
    }
    if (["failed", "cancelled"].includes(attempt.state))
      return finish({
        phase: r.cancelRequested ? "cancelled" : attempt.state,
      });
    if (attempt.reviewedAt)
      return finish({ phase: "failed", diagnostic: "OUTCOME_REVIEWED" });
    if (["uncertain", "interrupted"].includes(attempt.state)) {
      if (r.phase !== "uncertain") this.teams.write(r, { phase: "uncertain" });
      return r;
    }
    // The Gateway confirmed a send whose acknowledgement was lost (run-confirmation.js).
    if (r.phase === "uncertain") r = this.teams.write(r, { phase: "running" });
    const started = Date.parse(r.startedAt);
    if (
      !r.cancelRequested &&
      Number.isFinite(started) &&
      Date.now() - started >= (r.runTimeoutMinutes || 10) * 60000
    ) {
      this.teams.write(r, { cancelRequested: true, cancelledBy: "deadline" });
      try {
        await a.cancel(r.attemptId);
      } catch {
        /* Observed until the runtime confirms the end. */
      }
    }
    return r;
  }
  /** Hands a finished request on; see deliverRequest. */
  deliver(id) {
    return deliverRequest(this, id);
  }
  /** Where a finished request is delivered: a sibling's asker, or the lead's chat. */
  deliveryTarget(r) {
    if (r.fromMemberId && this.peers) return this.peers.target(r);
    return {
      conversationId:
        r.origin?.kind === "member-report" && this.reports
          ? this.reports.conversationId(r)
          : r.parentConversationId,
      clientRequestId: `lead-request-result:${r.id}`,
      text: followUp({ ...r, answer: this.store.answer(r) }),
      context: { kind: "member-result", requestId: r.id },
    };
  }
  async close() {
    this.closed = true;
    for (const stop of [...this.waits.keys()]) stop();
    await this.running;
  }
}
