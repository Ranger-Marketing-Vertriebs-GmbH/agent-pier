import { randomUUID, createHash } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
// Questions and tasks a lead agent sends to its own members. They live in the team
// store as `lead-request` records beside the teams and members they refer to.
export const requestKind = "lead-request";
export const requestTerminal = new Set(["completed", "failed", "cancelled", "declined"]);
export const requestLimits = { question: 4000, task: 8192, answer: 6000 };
// Open requests per lead; a lead cannot flood its members or the owner's approvals.
const maxOpenPerLead = 16;
const memberTerminal = new Set(["completed", "failed", "cancelled"]);
const plain = (value) =>
  value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
// The same proof team proposals use, without the word "team": a verbatim excerpt
// of at least three words from the text AgentPier received for this very request.
export const ownerQuote = (quote, text) =>
  typeof quote === "string" &&
  typeof text === "string" &&
  !!quote.trim() &&
  quote.length <= 300 &&
  plain(quote).split(" ").length >= 3 &&
  plain(text).includes(plain(quote));
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
    return this.teams
      .rows(requestKind)
      .filter((r) => !parentId || r.parentAssistantId === parentId);
  }
  get(id) {
    const r = this.teams.get(id);
    if (r.kind !== requestKind) throw assistantProblem("notFound", 404);
    return r;
  }
  open(filter = () => true) {
    return this.list().filter((r) => !requestTerminal.has(r.phase) && filter(r));
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
      if (this.open((r) => r.parentAssistantId === lead.id).length >= maxOpenPerLead)
        throw assistantProblem("active", 409);
      const context = t.context(request.id),
        policy = t.policy(lead.id);
      const ownerTurn =
        ["owner", "telegram"].includes(context.kind) && !context.forwarded;
      // Only AgentPier's record of the turn and the owner's own words authorise; a
      // model's claim alone leads to an approval request.
      const authorization =
        ownerTurn && quote && ownerQuote(quote, request.text)
          ? {
              kind: "task",
              requestId: request.id,
              source: "ownerRequest",
              ownerRequestQuote: quote,
            }
          : ownerTurn && policy.autonomous
            ? { kind: "standing", policyRevision: policy.revision }
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
        ...(decision === "decline"
          ? { finishedAt: new Date().toISOString(), delivery: "skipped" }
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
      new Set(memberIds).size !== memberIds.length
    )
      throw assistantProblem("invalid");
    return memberIds.map((id) => {
      const { member } = this.ownMember(leadId, id);
      if (
        member.lifetime !== "task" ||
        !memberTerminal.has(member.phase) ||
        this.teams.activeMember(member) ||
        this.open((r) => r.memberId === member.id).length
      )
        throw assistantProblem("memberRequestNotFinished", 409);
      return member;
    });
  }
}
// What the browser and the lead's tools see of a request.
export function publicRequest(r, { answers = true } = {}) {
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
    text: r.text,
    phase: r.phase,
    createdAt: r.createdAt,
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(answers && r.answer ? { answer: r.answer } : {}),
    ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
    ...(r.delivery ? { delivery: r.delivery } : {}),
    ...(r.authorization?.source === "ownerRequest"
      ? { ownerRequestQuote: r.authorization.ownerRequestQuote }
      : {}),
  };
}
