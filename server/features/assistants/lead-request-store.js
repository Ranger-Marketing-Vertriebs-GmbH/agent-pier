import { randomUUID, createHash } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { intent, namesMember, ownerQuote, plain } from "./lead-request-proof.js";
export { ownerQuote } from "./lead-request-proof.js";
// Questions and tasks a lead agent sends to its own members. They live in the team
// store as `lead-request` records beside the teams and members they refer to.
export const requestKind = "lead-request";
export const requestTerminal = new Set(["completed", "failed", "cancelled", "declined"]);
export const requestLimits = { question: 4000, task: 8192, answer: 6000 };
// Bounds an injected lead or a member answer that keeps asking cannot exceed: open
// requests per lead, requests per lead and minute, requests per owner turn, and the
// owner-requested ones of a turn that skip the approval.
export const requestCaps = { open: 16, perMinute: 6, perTurn: 8, ownerPerTurn: 3 };
// Finished requests kept per lead, and for how long.
export const retention = { perLead: 200, days: 30 };
const memberTerminal = new Set(["completed", "failed", "cancelled"]);
const terminalList = [...requestTerminal].map((p) => `'${p}'`).join(",");
const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function exact(input, keys, required) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k)) ||
    required.some((k) => !(k in input))
  )
    throw assistantProblem("invalid");
}
export class LeadRequestStore {
  constructor(teams) {
    this.teams = teams;
  }
  list(parentId) {
    if (!parentId) return this.teams.rows(requestKind);
    return this.teams.db
      .prepare(
        "SELECT body FROM assistant_team_records WHERE parent_id=? AND kind=? ORDER BY rowid",
      )
      .all(parentId, requestKind)
      .map((r) => JSON.parse(r.body));
  }
  /** Requests a scheduling pass still has to look at: open, or not yet settled. */
  pending() {
    return this.teams.db
      .prepare(
        `SELECT body FROM assistant_team_records WHERE kind=? AND (phase NOT IN (${terminalList}) OR json_extract(body,'$.settled') IS NOT 1) ORDER BY rowid`,
      )
      .all(requestKind)
      .map((r) => JSON.parse(r.body));
  }
  /**
   * Drops settled requests beyond the newest `retention.perLead` of a lead or older
   * than `retention.days`; open or undelivered ones always stay.
   */
  prune(now = Date.now()) {
    const cutoff = now - retention.days * 86400000;
    const byLead = new Map();
    for (const r of this.teams.rows(requestKind)) {
      if (!r.settled || !requestTerminal.has(r.phase)) continue;
      if (!byLead.has(r.parentAssistantId)) byLead.set(r.parentAssistantId, []);
      byLead.get(r.parentAssistantId).push(r);
    }
    const remove = this.teams.db.prepare(
      "DELETE FROM assistant_team_records WHERE id=? AND kind=?",
    );
    let removed = 0;
    for (const list of byLead.values())
      list.forEach((r, n) => {
        const at = Date.parse(r.finishedAt || r.createdAt);
        if (n < list.length - retention.perLead || !(at >= cutoff))
          removed += remove.run(r.id, requestKind).changes;
      });
    return removed;
  }
  get(id) {
    const r = this.teams.get(id);
    if (r.kind !== requestKind) throw assistantProblem("notFound", 404);
    return r;
  }
  open(filter = () => true) {
    return this.teams.db
      .prepare(
        `SELECT body FROM assistant_team_records WHERE kind=? AND phase NOT IN (${terminalList}) ORDER BY rowid`,
      )
      .all(requestKind)
      .map((r) => JSON.parse(r.body))
      .filter(filter);
  }
  /** The calling lead, resolved from its attempt; members and archived agents never lead. */
  lead(attemptId) {
    const { ledger, store } = this.teams;
    const attempt = ledger.getAttempt(attemptId),
      request = ledger.getRequest(attempt.requestId),
      conversation = store.getConversation(request.conversationId),
      lead = store.getAssistant(conversation.assistantId);
    if (lead.teamMemberId || lead.archivedAt) throw assistantProblem("invalid", 403);
    return { attempt, request, conversation, lead };
  }
  /** A member of exactly this lead that can still be reached. */
  ownMember(leadId, memberId) {
    textValue(memberId, 100);
    const m = this.teams.find(memberId);
    if (!m || m.kind !== "member" || m.parentAssistantId !== leadId)
      throw assistantProblem("notFound", 404);
    const assistant = this.teams.store.getAssistant(m.assistantId);
    if (m.archivedAt || assistant.archivedAt) throw assistantProblem("notFound", 404);
    return { member: m, assistant };
  }
  create({ type, attemptId, operationId, input }) {
    const field = type === "task" ? "task" : "question";
    exact(
      input,
      ["memberId", field, "ownerRequested", "ownerRequestQuote"],
      ["memberId", field],
    );
    textValue(operationId, 256);
    const text = textValue(input[field], requestLimits[type]);
    if ("ownerRequested" in input && typeof input.ownerRequested !== "boolean")
      throw assistantProblem("invalid");
    const quote =
      input.ownerRequested === true && typeof input.ownerRequestQuote === "string"
        ? input.ownerRequestQuote
        : undefined;
    const t = this.teams;
    return t.transaction(() => {
      const { request, conversation, lead } = this.lead(attemptId);
      const key = `${attemptId}:${operationId}`;
      const hash = fingerprint({ type, memberId: input.memberId, text });
      const old = t.db
        .prepare("SELECT id FROM assistant_team_records WHERE operation_key=?")
        .get(key);
      if (old) {
        const existing = t.get(old.id);
        if (existing.fingerprint !== hash) throw assistantProblem("conflict", 409);
        return existing;
      }
      const { member, assistant } = this.ownMember(lead.id, input.memberId);
      if (!member.conversationId) throw assistantProblem("memberRequestUnavailable", 409);
      if (type === "task") {
        if (member.lifetime !== "permanent" || assistant.lifetime !== "permanent")
          throw assistantProblem("memberRequestNotPermanent", 409);
        if (this.open((r) => r.memberId === member.id && r.type === "task").length)
          throw assistantProblem("memberRequestOpenTask", 409);
      }
      const mine = this.list(lead.id),
        turn = mine.filter((r) => r.parentRequestId === request.id),
        now = Date.now();
      if (mine.filter((r) => !requestTerminal.has(r.phase)).length >= requestCaps.open)
        throw assistantProblem("active", 409);
      if (
        turn.length >= requestCaps.perTurn ||
        mine.filter((r) => now - Date.parse(r.createdAt) < 60000).length >=
          requestCaps.perMinute
      )
        throw assistantProblem("memberRequestRate", 429);
      const context = t.context(request.id),
        policy = t.policy(lead.id);
      const ownerTurn =
        ["owner", "telegram"].includes(context.kind) && !context.forwarded;
      const owned = turn.filter((r) => r.authorization?.source === "ownerRequest");
      // Only AgentPier's record of the turn and the owner's own words for this
      // member authorise: a verbatim quote that names the member and says to ask or
      // delegate, used once, for at most a few requests of the turn. A lead's claim,
      // standing team permission or any other turn leads to an approval request.
      const others = t
        .members()
        .filter((m) => m.parentAssistantId === lead.id && m.id !== member.id)
        .map((m) => this.teams.store.getAssistant(m.assistantId).name);
      const proven =
        ownerTurn &&
        !!quote &&
        ownerQuote(quote, request.text) &&
        namesMember(quote, assistant.name, others) &&
        intent(quote) &&
        owned.length < requestCaps.ownerPerTurn &&
        !owned.some((r) => plain(r.authorization.ownerRequestQuote) === plain(quote));
      const authorization = proven
        ? {
            kind: "task",
            requestId: request.id,
            source: "ownerRequest",
            ownerRequestQuote: quote,
          }
        : null;
      return t.insert(
        {
          id: randomUUID(),
          kind: requestKind,
          revision: 1,
          type,
          parentAssistantId: lead.id,
          parentConversationId: conversation.id,
          parentRequestId: request.id,
          parentAttemptId: attemptId,
          leadName: lead.name,
          memberId: member.id,
          memberAssistantId: member.assistantId,
          memberName: assistant.name,
          text,
          origin: context,
          authorization,
          // A task the owner asked for in plain words may change files in the
          // member's own workspace; an approval grants the same, nothing else does.
          writeAllowed: type === "task" && !!authorization,
          runTimeoutMinutes: policy.runTimeoutMinutes,
          phase: authorization ? "queued" : "awaiting_approval",
          fingerprint: hash,
          delivery: null,
          createdAt: new Date().toISOString(),
        },
        key,
      );
    });
  }
  decide(id, { revision, decision }, owner) {
    return this.teams.transaction(() => {
      if (!["owner", "telegram"].includes(owner?.kind))
        throw assistantProblem("invalid", 403);
      const r = this.get(id);
      if (r.phase !== "awaiting_approval" || r.revision !== revision)
        throw assistantProblem("conflict", 409);
      if (!["approve", "decline"].includes(decision)) throw assistantProblem("invalid");
      if (
        owner.kind === "telegram" &&
        (r.origin?.kind !== "telegram" ||
          ["channelId", "chatId", "userId"].some((k) => r.origin[k] !== owner[k]))
      )
        throw assistantProblem("invalid", 403);
      if (decision === "approve") {
        // The member may have been archived or a task opened meanwhile.
        this.ownMember(r.parentAssistantId, r.memberId);
        if (
          r.type === "task" &&
          this.open(
            (x) => x.id !== r.id && x.memberId === r.memberId && x.type === "task",
          ).some((x) => x.phase !== "awaiting_approval")
        )
          throw assistantProblem("memberRequestOpenTask", 409);
      }
      return this.teams.write(r, {
        phase: decision === "approve" ? "queued" : "declined",
        authorization:
          decision === "approve"
            ? { kind: "approval", requestId: id, owner: owner.kind }
            : null,
        writeAllowed: decision === "approve" && r.type === "task",
        ...(decision === "decline"
          ? { finishedAt: new Date().toISOString(), delivery: "skipped", settled: true }
          : {}),
      });
    });
  }
  /** The archive checks a lead's tidy-up must pass for every member it names. */
  archivable(leadId, memberIds) {
    if (
      !Array.isArray(memberIds) ||
      !memberIds.length ||
      memberIds.length > 8 ||
      new Set(memberIds).size !== memberIds.length ||
      memberIds.some((id) => typeof id !== "string")
    )
      throw assistantProblem("invalid");
    return memberIds.map((id) => this.assertArchivable(leadId, id));
  }
  /** Run again inside the archiving transaction, so nothing changes in between. */
  assertArchivable(leadId, id) {
    const { member } = this.ownMember(leadId, id);
    if (
      member.lifetime !== "task" ||
      this.teams.store.getAssistant(member.assistantId).lifetime === "permanent" ||
      !memberTerminal.has(member.phase) ||
      this.teams.activeMember(member) ||
      this.open((r) => r.memberId === member.id).length
    )
      throw assistantProblem("memberRequestNotFinished", 409);
    return member;
  }
}
const excerpt = (text, max) =>
  Array.from(text || "")
    .slice(0, max)
    .join("");
/**
 * What the browser sees of a request. The list carries a summary; `full` adds the
 * whole text and answer, loaded on demand. `member` describes what the member may
 * do (shell level, MCP servers), so an approval is informed.
 */
export function publicRequest(r, { full = false, member } = {}) {
  const short = excerpt(r.text, 300);
  return {
    id: r.id,
    kind: r.kind,
    revision: r.revision,
    type: r.type,
    parentAssistantId: r.parentAssistantId,
    memberId: r.memberId,
    memberAssistantId: r.memberAssistantId,
    memberName: r.memberName,
    leadName: r.leadName,
    text: full ? r.text : short,
    ...(!full && short.length < (r.text || "").length ? { truncated: true } : {}),
    phase: r.phase,
    createdAt: r.createdAt,
    writeAllowed: !!r.writeAllowed,
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(r.answer ? (full ? { answer: r.answer } : { hasAnswer: true }) : {}),
    ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
    ...(r.delivery ? { delivery: r.delivery } : {}),
    ...(r.resultDiagnostic ? { resultDiagnostic: r.resultDiagnostic } : {}),
    ...(member ? { member } : {}),
    ...(r.authorization?.source === "ownerRequest"
      ? { ownerRequestQuote: r.authorization.ownerRequestQuote }
      : {}),
  };
}
