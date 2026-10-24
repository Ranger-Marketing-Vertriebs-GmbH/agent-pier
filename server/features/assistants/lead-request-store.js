import { randomUUID, createHash } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import { dropTexts, readText } from "./team-texts.js";
import {
  intent,
  namesMember,
  messageNegated,
  ownerConsent,
  ownerMentions,
  ownerProse,
  ownerQuoteProof,
  parseOwnerText,
  plain,
} from "./lead-request-proof.js";
import { autonomousCaps } from "./team-policy.js";
import { directOwnerTurn, goalTurn, ownerSource } from "./goal-turns.js";
import { WorkGoalStore } from "./work-goal-store.js";
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
// Members' requests to each other and their own reports have their own bound per
// lead, so a busy team never pushes the lead's own request history out.
export const retention = { perLead: 200, membersPerLead: 200, days: 30 };
const fromMembers = (r) => !!r.fromMemberId || r.origin?.kind === "member-report";
const memberTerminal = new Set(["completed", "failed", "cancelled"]);
const terminalList = [...requestTerminal].map((p) => `'${p}'`).join(",");
export const fingerprint = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** An input object with only these keys and all the required ones. */
export function exact(input, keys, required) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !keys.includes(k)) ||
    required.some((k) => !(k in input))
  )
    throw assistantProblem("invalid");
}
/**
 * Whether a lead's task may change files: a task the owner asked for (ownerProof),
 * one an autonomous lead started in the owner's own turn, or one a routine the owner
 * marked "May write" started (routineWrites, the owner's standing instruction), one
 * a lead started in a goal turn (goalId, goal-turns.js), or a member's task for a
 * sibling sent from a turn that may write itself (peerWrites, peer-request-rules.js);
 * never once cancelled. Where and when it writes is checked apart.
 */
export const taskWritable = (r) =>
  !!r &&
  r.kind === requestKind &&
  r.type === "task" &&
  r.writeAllowed === true &&
  (!!r.ownerProof ||
    r.autonomous === true ||
    r.routineWrites === true ||
    typeof r.goalId === "string" ||
    (!!r.fromMemberId && !!r.peerWrites)) &&
  !r.cancelRequested;
/**
 * Who calls a lead tool: an attempt of the lead's chat, or a routine's own run
 * session (TeamBridge admits only ask, delegate and members there). The routine's
 * name comes from its binding, never from the lead.
 */
export const callerOf = (inv) =>
  inv.attemptId
    ? { attemptId: inv.attemptId }
    : inv.routine
      ? {
          routine: {
            bindingId: inv.routine.binding.id,
            name: inv.routine.binding.definition?.name || "",
            // The owner's own switch on the routine, never the lead's.
            writes: inv.routine.binding.routineWrites === true,
            conversationId: inv.routine.conversation.id,
            sessionKey: inv.sessionKey,
          },
        }
      : { attemptId: null };
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
   * Drops settled requests beyond the newest `retention.perLead` of a lead (and
   * `retention.membersPerLead` of its members' own) or older than `retention.days`;
   * open or undelivered ones always stay.
   */
  prune(now = Date.now()) {
    const cutoff = now - retention.days * 86400000;
    const byLead = new Map();
    for (const r of this.teams.rows(requestKind)) {
      if (!r.settled || !requestTerminal.has(r.phase)) continue;
      const key = `${fromMembers(r) ? "members" : "lead"}:${r.parentAssistantId}`;
      if (!byLead.has(key)) byLead.set(key, []);
      byLead.get(key).push(r);
    }
    const remove = this.teams.db.prepare(
      "DELETE FROM assistant_team_records WHERE id=? AND kind=?",
    );
    let removed = 0;
    // A request and its whole answer go together.
    this.teams.transaction(() => {
      for (const [key, list] of byLead) {
        const keep = key.startsWith("members:")
          ? retention.membersPerLead
          : retention.perLead;
        list.forEach((r, n) => {
          const at = Date.parse(r.finishedAt || r.createdAt);
          if (n < list.length - keep || !(at >= cutoff)) {
            const gone = remove.run(r.id, requestKind).changes;
            if (gone) dropTexts(this.teams.db, r.id);
            removed += gone;
          }
        });
      }
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
  /**
   * The calling lead of a tool call: from its attempt, or for a routine's own run
   * session (no attempt, TeamBridge.routineRun) from the chat the routine belongs to.
   * The same rules hold: members and archived agents never lead.
   */
  caller({ attemptId, routine }) {
    if (attemptId) return this.lead(attemptId);
    if (!routine) throw assistantProblem("invalid", 403);
    const conversation = this.teams.store.getConversation(routine.conversationId),
      lead = this.teams.store.getAssistant(conversation.assistantId);
    if (lead.teamMemberId || lead.archivedAt) throw assistantProblem("invalid", 403);
    return { attempt: null, request: null, conversation, lead };
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
  // `offer`: the lead's last reply before this turn (LeadRequests.lastReply), which
  // must name the member for the owner's yes to count. `routine` ({ bindingId,
  // name, conversationId, sessionKey }) stands for the attempt when a routine's run
  // calls: its own origin, never owner text, so its tasks always run read-only.
  create({ type, attemptId = null, routine = null, operationId, input, offer = null }) {
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
    // In a goal turn the owner's message is the anchor's, never the turn's own text.
    let owner = null;
    if (!routine) {
      try {
        const { request } = this.lead(attemptId);
        const source = ownerSource(t, request);
        const parsed = parseOwnerText(source.request.text, source.context.hidden);
        owner = { requestId: request.id, parsed };
      } catch {
        owner = null;
      }
    }
    return t.transaction(() => {
      const { request, conversation, lead } = this.caller({ attemptId, routine });
      // A routine run is its own turn: its session key names the run.
      const run = routine ? `routine:${textValue(routine.sessionKey, 512)}` : null;
      const key = `${run || attemptId}:${operationId}`;
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
      // Reports of the lead's routines on members (lead-routine-reports.js) and
      // its members' requests to each other (peer-request-rules.js) are not the
      // lead's own requests and never count against its caps.
      const mine = this.list(lead.id).filter(
          (r) => r.type !== "report" && !r.fromMemberId,
        ),
        turn = mine.filter((r) =>
          run ? r.routineRun === run : r.parentRequestId === request.id,
        ),
        now = Date.now();
      if (mine.filter((r) => !requestTerminal.has(r.phase)).length >= requestCaps.open)
        throw assistantProblem("active", 409);
      if (
        turn.length >= requestCaps.perTurn ||
        mine.filter((r) => now - Date.parse(r.createdAt) < 60000).length >=
          requestCaps.perMinute
      )
        throw assistantProblem("memberRequestRate", 429);
      const context = routine
          ? {
              kind: "routine",
              bindingId: routine.bindingId,
              name: routine.name,
              ...(routine.writes ? { writes: true } : {}),
            }
          : t.context(request.id),
        policy = t.policy(lead.id);
      // A goal turn (continuation or goal member result, goal-turns.js) proves only
      // what its anchor, the owner's latest direct turn, proves: one owner sentence
      // or mention proves one task across the anchor and all its continuations.
      const source = request && !routine ? ownerSource(t, request) : null,
        goal = goalTurn(context);
      const ownerTurn = goal
        ? directOwnerTurn(source.context)
        : ["owner", "telegram"].includes(context.kind) && !context.forwarded;
      const proofId = source?.request.id ?? request?.id;
      const proofs = mine.filter(
        (r) => r.ownerProof && r.ownerProof.requestId === proofId,
      );
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
      const parsed = !request
        ? null
        : owner?.requestId === request.id
          ? owner.parsed
          : parseOwnerText(source.request.text, source.context.hidden);
      const sentence = quote && parsed ? ownerQuoteProof(quote, parsed) : null;
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
          ? { requestId: proofId, quote, sentence: sentence.index }
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
            requestId: proofId,
            quote: m.excerpt,
            sentence: m.sentence,
            mention: m.ordinal,
          };
      }
      // Third way, where the lead offers members first (team usage "suggest" or
      // "autonomous"): the owner's own short yes in this turn to the lead's last
      // reply, which named this member, once per turn, in a message that names no
      // other member. Never in a goal turn: the yes answered another reply.
      const prose = ownerTurn ? ownerProse(parsed) || "" : "";
      const usage = policy.usage;
      if (open && !proof && quote && parsed && usage !== "onRequest" && !goal) {
        const yes = ownerConsent(quote, parsed);
        if (
          yes &&
          typeof offer === "string" &&
          namesMember(offer, assistant.name, others) &&
          !proofs.some((r) => r.ownerProof.consent) &&
          !others.some((name) =>
            namesMember(prose, name, [
              assistant.name,
              ...others.filter((o) => o !== name),
            ]),
          )
        )
          proof = { requestId: proofId, quote, sentence: yes.index, consent: true };
      }
      // Whether the owner's message in this turn names the member at all; only for
      // the record and the autonomous caps, never for a permission.
      const named = !!prose && namesMember(prose, assistant.name, others);
      // A negation or limit anywhere in the owner's message ("but don't change
      // anything") keeps every task of the turn read-only.
      const negated = !parsed || messageNegated(parsed);
      // The owner's ruling: in a goal turn the goal is the owner's involvement, so a
      // task without a proof may write like an autonomous lead's own one, whatever
      // the team usage and whether or not the anchor names the member. Capped per
      // turn; the hourly limit neither counts nor refuses it. Only while the goal is
      // still open: a continuation that runs on after Stop is no goal turn.
      const goalTask =
        type === "task" &&
        !!goal &&
        new WorkGoalStore(t).open(conversation.id)?.id === goal.id &&
        !proof &&
        ownerTurn &&
        !negated;
      const selfInitiated = (usage === "autonomous" && !proof && !named) || goalTask;
      if (selfInitiated) {
        const own = mine.filter((r) => r.selfInitiated);
        if (
          own.filter((r) => turn.includes(r)).length >= autonomousCaps.perTurn ||
          (!goalTask &&
            own.filter((r) => !r.goalId && now - Date.parse(r.createdAt) < 3600000)
              .length >= autonomousCaps.perHour)
        )
          throw assistantProblem("memberRequestAutonomousLimit", 429);
      }
      // An autonomous lead's own task in a turn of the owner's own message may change
      // the member's own workspace too, always marked self-initiated and capped. A
      // task for a member the owner named without a valid proof, a negated message
      // and other turns run read-only. Shell, SSH, project folders, GitHub and
      // grants keep their own approvals.
      const autonomous =
        type === "task" && selfInitiated && !goalTask && ownerTurn && !negated;
      // A routine the owner marked "May write" stands for the
      // owner's instruction: its tasks may change files like an owner-proven one.
      const routineWrites = type === "task" && !!routine?.writes;
      return t.insert(
        {
          id: randomUUID(),
          kind: requestKind,
          revision: 1,
          type,
          parentAssistantId: lead.id,
          parentConversationId: conversation.id,
          parentRequestId: request?.id ?? null,
          parentAttemptId: attemptId,
          ...(run ? { routineRun: run } : {}),
          leadName: lead.name,
          memberId: member.id,
          memberAssistantId: member.assistantId,
          memberName: assistant.name,
          text,
          origin: context,
          ownerProof: proof,
          writeAllowed: !!proof || autonomous || routineWrites || goalTask,
          ...(autonomous ? { autonomous: true } : {}),
          ...(goalTask ? { goalId: goal.id } : {}),
          ...(routineWrites ? { routineWrites: true } : {}),
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
  /**
   * The lead's turn handling this request's result tried something only the owner's
   * own message allows (SSH, agent-ssh.js): the chat then offers the owner a "go
   * ahead" (conversations.js goAheadMarks). Returns whether it marked; never throws.
   */
  refusedChange(requestId) {
    try {
      const r = typeof requestId === "string" ? this.teams.find(requestId) : null;
      if (!r || r.kind !== requestKind || r.resultWriteRefused) return false;
      this.teams.write(r, { resultWriteRefused: true });
      return true;
    } catch {
      return false;
    }
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
    ...(r.routineWrites ? { routineWrites: true } : {}),
    // Started by the lead's routine of this name, never by the owner's text.
    ...(r.origin?.kind === "routine" && r.routineRun
      ? { routine: textOr(r.origin.name) }
      : {}),
    // A report of the lead's routine of this name on the member.
    ...(r.origin?.kind === "member-routine"
      ? { memberRoutine: textOr(r.origin.name) }
      : {}),
    // A member's own report: a result or a problem, maybe from its routine.
    ...(r.origin?.kind === "member-report"
      ? {
          reportKind: r.origin.reportKind,
          files: Array.isArray(r.files) ? r.files : [],
          ...(typeof r.origin.routine === "string"
            ? { memberRoutine: r.origin.routine }
            : {}),
        }
      : {}),
    ...(r.startedAt ? { startedAt: r.startedAt } : {}),
    ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}),
    ...(r.answer ? (full ? { answer: r.answer } : { hasAnswer: true }) : {}),
    ...(r.answerCut ? { answerCut: true } : {}),
    ...(r.diagnostic ? { diagnostic: r.diagnostic } : {}),
    ...(r.delivery ? { delivery: r.delivery } : {}),
    ...(r.resultDiagnostic ? { resultDiagnostic: r.resultDiagnostic } : {}),
    ...(r.ownerProof ? { ownerRequestQuote: r.ownerProof.quote } : {}),
    // A member's request to a sibling (peer-request-rules.js).
    ...(r.fromMemberId
      ? {
          fromMemberId: r.fromMemberId,
          fromName: textOr(r.fromName),
          resultTo: r.resultTo,
        }
      : {}),
  };
}
const textOr = (value) => (typeof value === "string" ? value : "");
