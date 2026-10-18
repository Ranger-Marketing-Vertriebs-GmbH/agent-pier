import { randomUUID, createHash } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { dropTexts, readText } from "./team-texts.js";
import {
  intent,
  namesMember,
  ownerConsent,
  ownerMentions,
  ownerProse,
  ownerQuoteProof,
  parseOwnerText,
  plain,
} from "./lead-request-proof.js";
import { autonomousCaps } from "./team-policy.js";
export { ownerQuote } from "./lead-request-proof.js";
// Questions and tasks a lead agent sends to its own members. They live in the team
// store as `lead-request` records beside the teams and members they refer to.
export const requestKind = "lead-request";
export const requestTerminal = new Set(["completed", "failed", "cancelled"]);
// A member's answer is kept up to the history limit (history-text.js), not here.
export const requestLimits = { question: 4000, task: 8192 };
// Bounds an injected lead or a member answer that keeps asking cannot exceed: open
// requests per lead, requests per lead and minute, requests per owner turn, and the
// owner-proven tasks of a turn that may write.
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
    // A request and its whole answer go together.
    this.teams.transaction(() => {
      for (const list of byLead.values())
        list.forEach((r, n) => {
          const at = Date.parse(r.finishedAt || r.createdAt);
          if (n < list.length - retention.perLead || !(at >= cutoff)) {
            const gone = remove.run(r.id, requestKind).changes;
            if (gone) dropTexts(this.teams.db, r.id);
            removed += gone;
          }
        });
    });
    return removed;
  }
  /** The member's whole answer: its own row, or the record's text of older ones. */
  answer(r) {
    return (
      (r.answerTruncated && readText(this.teams.db, r.id, "answer")) || r.answer || ""
    );
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
      // Only a task can be owner-proven; a question never changes files.
      type === "task"
        ? ["memberId", field, "ownerRequested", "ownerRequestQuote"]
        : ["memberId", field],
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
    // The owner's message is parsed for the proofs before the transaction; inside
    // it only a parse of the same request (its text and context never change) is used.
    let owner = null;
    {
      try {
        const { request } = this.lead(attemptId);
        const parsed = parseOwnerText(request.text, t.context(request.id).hidden);
        owner = { requestId: request.id, parsed };
      } catch {
        owner = null;
      }
    }
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
      const proofs = turn.filter((r) => r.ownerProof);
      // Requests always run. Only a task the owner explicitly asked for in this
      // very turn may change files in the member's workspace: AgentPier's record of
      // the turn plus a verbatim quote of the owner's words that names the member
      // and says to delegate, used once, for at most a few tasks of the turn. A
      // lead's claim, standing team permission or any other turn runs read-only.
      // An @mention of the member in the owner's own message (where the chat shows
      // a chip) counts as the request on its own, whatever the lead quoted; an
      // ambiguous mention proves nothing.
      const siblings = t
        .members()
        .filter((m) => m.parentAssistantId === lead.id)
        .map((m) => ({ m, profile: this.teams.store.getAssistant(m.assistantId) }));
      const others = siblings
        .filter(({ m }) => m.id !== member.id)
        .map(({ profile }) => profile.name);
      const mentionable = siblings
        .filter(({ m, profile }) => !m.archivedAt && !profile.archivedAt)
        .map(({ m, profile }) => ({ id: m.id, name: profile.name }));
      // Only the owner's own prose proves anything: never text the owner quoted,
      // pasted, coded or linked (Markdown, or a Telegram message's formatting).
      const parsed =
        owner?.requestId === request.id
          ? owner.parsed
          : parseOwnerText(request.text, context.hidden);
      const sentence = quote ? ownerQuoteProof(quote, parsed) : null;
      // The lead's quote proves a request only by name and an ask or delegate verb;
      // mentions count only from the owner's own message below.
      const addressed =
        !!sentence && namesMember(quote, assistant.name, others) && intent(quote);
      const open =
        type === "task" && ownerTurn && proofs.length < requestCaps.ownerPerTurn;
      // One proof per owner sentence and member, and per mention: overlapping
      // excerpts or a repeated mention authorise one task, not several.
      const used = (index, mention = -1) =>
        proofs.some(
          (r) =>
            (r.memberId === member.id && r.ownerProof.sentence === index) ||
            (mention >= 0 && r.ownerProof.mention === mention),
        );
      let proof =
        open &&
        !!sentence &&
        !sentence.negated &&
        !sentence.quoted &&
        addressed &&
        !used(sentence.index) &&
        !proofs.some((r) => plain(r.ownerProof.quote) === plain(quote))
          ? { requestId: request.id, quote, sentence: sentence.index }
          : null;
      // Second way: the owner's own message @mentions this member, whatever the
      // lead quoted.
      if (open && !proof) {
        const m = ownerMentions(parsed, mentionable).find(
          (x) =>
            x.memberId === member.id &&
            !x.negated &&
            !x.quoted &&
            !used(x.sentence, x.ordinal),
        );
        if (m)
          proof = {
            requestId: request.id,
            quote: m.excerpt,
            sentence: m.sentence,
            mention: m.ordinal,
          };
      }
      // Third way, where the lead offers members first (team usage "suggest" or
      // "autonomous"): the owner's own short yes in this turn, once per turn, in a
      // message that names no other member.
      const prose = ownerTurn ? ownerProse(parsed) || "" : "";
      const usage = policy.usage;
      if (open && !proof && quote && usage !== "onRequest") {
        const yes = ownerConsent(quote, parsed);
        if (
          yes &&
          !proofs.some((r) => r.ownerProof.consent) &&
          !others.some((name) =>
            namesMember(prose, name, [
              assistant.name,
              ...others.filter((o) => o !== name),
            ]),
          )
        )
          proof = { requestId: request.id, quote, sentence: yes.index, consent: true };
      }
      // Whether the owner's message in this turn names the member at all; only for
      // the record and the autonomous caps, never for a permission.
      const named = !!prose && namesMember(prose, assistant.name, others);
      const selfInitiated = usage === "autonomous" && !proof && !named;
      if (selfInitiated) {
        const own = mine.filter((r) => r.selfInitiated);
        if (
          own.filter((r) => r.parentRequestId === request.id).length >=
            autonomousCaps.perTurn ||
          own.filter((r) => now - Date.parse(r.createdAt) < 3600000).length >=
            autonomousCaps.perHour
        )
          throw assistantProblem("memberRequestAutonomousLimit", 429);
      }
      // An autonomous lead's own task in a turn of the owner's own message may change
      // the member's own workspace too; other turns' tasks run read-only. Shell, SSH,
      // project folders, GitHub and grants keep their own approvals.
      const autonomous = type === "task" && !proof && usage === "autonomous" && ownerTurn;
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
          ownerProof: proof,
          writeAllowed: !!proof || autonomous,
          ...(autonomous ? { autonomous: true } : {}),
          ...(selfInitiated ? { selfInitiated: true } : {}),
          runTimeoutMinutes: policy.runTimeoutMinutes,
          phase: "queued",
          fingerprint: hash,
          delivery: null,
          createdAt: new Date().toISOString(),
        },
        key,
      );
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
 * whole text and answer, loaded on demand.
 */
export function publicRequest(r, { full = false } = {}) {
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
    ...(r.selfInitiated ? { selfInitiated: true } : {}),
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(r.answer ? (full ? { answer: r.answer } : { hasAnswer: true }) : {}),
    ...(r.answerCut ? { answerCut: true } : {}),
    ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
    ...(r.delivery ? { delivery: r.delivery } : {}),
    ...(r.resultDiagnostic ? { resultDiagnostic: r.resultDiagnostic } : {}),
    ...(r.ownerProof ? { ownerRequestQuote: r.ownerProof.quote } : {}),
  };
}
