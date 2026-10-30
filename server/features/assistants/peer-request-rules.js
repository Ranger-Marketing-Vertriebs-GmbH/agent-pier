import { randomUUID } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
import {
  exact,
  fingerprint,
  requestKind,
  requestLimits,
  taskWritable,
} from "./lead-request-store.js";
import { editableMember } from "./member-reach.js";
import { isLeadRoutine } from "./lead-routines.js";
import { mainConversation } from "./routine-targets.js";
import { taskRunTimeoutMinutes } from "./team-policy.js";
import { loopGuard } from "./agent-loop-guard.js";

// A team member's questions and tasks for a sibling of the same lead. They are
// `lead-request` records under the lead (parentAssistantId) with `fromMemberId`, so
// the lead's scheduler runs them; they never count against the lead's own caps.
// One open request per pair and direction; a chain or burst between members meets
// the sending member's loop guard (agent-loop-guard.js, AGENTPIER-276).
export const peerCaps = { openPerPair: 1 };
const refused = () => assistantProblem("invalid", 403);

// The member an agent belongs to, with its live lead; anything archived refuses.
function memberOf(service, assistant) {
  const teams = service.store,
    store = service.assistants.store;
  if (!assistant.teamMemberId || assistant.archivedAt) throw refused();
  const member = teams.find(assistant.teamMemberId);
  if (!member || member.kind !== "member" || member.archivedAt) throw refused();
  const lead = store.getAssistant(member.parentAssistantId);
  if (lead.teamMemberId || lead.archivedAt) throw refused();
  return { member, lead };
}

/**
 * The calling member of a tool call: from its attempt, or from its routine's own run
 * session (permanent members only), whose chat is the routine's. A lead, an archived
 * member, agent or lead never calls.
 */
export function peerCaller(service, inv) {
  const { ledger, store } = service.assistants;
  if (inv?.attemptId) {
    const attempt = ledger.getAttempt(inv.attemptId),
      request = ledger.getRequest(attempt.requestId),
      conversation = store.getConversation(request.conversationId),
      assistant = store.getAssistant(conversation.assistantId);
    const { member, lead } = memberOf(service, assistant);
    return {
      member,
      assistant,
      lead,
      conversation,
      origin: service.store.context(request.id),
      routine: null,
      attempt,
      request,
    };
  }
  if (!inv?.routine?.binding || !inv.routine.conversation) throw refused();
  // The bridge resolves both from the calling agent's own run session
  // (TeamBridge.routineRun): the routine's chat is its agent's own, never another's.
  const conversation = store.getConversation(inv.routine.conversation.id),
    assistant = store.getAssistant(conversation.assistantId);
  if (inv.routine.binding.assistantId !== assistant.id) throw refused();
  const { member, lead } = memberOf(service, assistant);
  if (member.lifetime !== "permanent" || assistant.lifetime !== "permanent")
    throw refused();
  const binding = inv.routine.binding;
  return {
    member,
    assistant,
    lead,
    conversation,
    origin: {
      kind: "routine",
      bindingId: binding.id,
      name: binding.definition?.name || "",
    },
    routine: { binding, sessionKey: textValue(inv.sessionKey, 512) },
    attempt: null,
    request: null,
  };
}

// The lead or peer request a turn handles, when its context names one.
const handled = (service, origin) => {
  const r = origin?.requestId ? service.store.find(origin.requestId) : null;
  return r?.kind === requestKind ? r : null;
};

/**
 * Whether a member's turn may ask, task or report (AGENTPIER-276): every turn of its
 * own work, also while it handles a sibling's request, apart from forwarded content,
 * a restricted user's turn and a memory step. The loop guard bounds chains and ping-pong.
 */
export function peerTurn(_service, caller) {
  return (
    !!caller.routine ||
    (!caller.origin?.forwarded && !["memory-step", "user"].includes(caller.origin?.kind))
  );
}

/**
 * Whether the sender's turn may write itself, and on what ground: the owner's own
 * message in the member's own chat, the owner-proven or otherwise writable lead task
 * this very attempt runs, or a routine run that may write. A peer task from any other
 * turn runs read-only.
 */
export function peerWriteOrigin(service, caller) {
  if (caller.routine)
    return service.assistants.routines?.writable(caller.routine.binding)
      ? { kind: "routine", bindingId: caller.routine.binding.id }
      : null;
  const origin = caller.origin;
  if (
    ["owner", "telegram"].includes(origin?.kind) &&
    !origin.forwarded &&
    caller.conversation.id === caller.member.conversationId
  )
    return { kind: "owner", requestId: caller.request.id };
  if (origin?.kind === "lead-request") {
    const r = handled(service, origin);
    if (
      taskWritable(r) &&
      !r.fromMemberId &&
      r.phase === "running" &&
      r.attemptId === caller.attempt?.id
    )
      return { kind: "lead-task", requestId: r.id };
  }
  return null;
}

/**
 * Whether the lead started the sender's turn: its request (question or task), a
 * temporary member's team assignment, or a routine the lead set up. The receiver then
 * reaches only the lead's standing shares, as in the lead's own requests; only the
 * owner's own turn or the owner's routine keeps the receiver's own access.
 */
export function peerLeadScope(caller) {
  if (caller.routine) return isLeadRoutine(caller.routine.binding);
  return ["lead-request", "team-member"].includes(caller.origin?.kind);
}

/**
 * A sibling of the sender the lead itself could still reach, with a chat; temporary
 * siblings take tasks too (AGENTPIER-276).
 */
export function peerTarget(service, lead, sender, memberId) {
  textValue(memberId, 100);
  const m = service.store.find(memberId);
  if (
    !m ||
    m.kind !== "member" ||
    !editableMember(m, lead.id) ||
    m.id === sender.id ||
    !m.conversationId
  )
    throw assistantProblem("notFound", 404);
  const assistant = service.assistants.store.getAssistant(m.assistantId);
  if (assistant.archivedAt) throw assistantProblem("notFound", 404);
  return { member: m, assistant };
}

/** The pair bound and the receiver's one open task (peerCaps). */
export function assertPeerLimits(store, sender, target, type) {
  const open = store.open((r) => r.fromMemberId === sender.id);
  if (
    open.filter((r) => r.memberId === target.id).length >= peerCaps.openPerPair ||
    (type === "task" &&
      store.open((r) => r.memberId === target.id && r.type === "task").length)
  )
    throw assistantProblem("peerRequestOpen", 409);
}

/**
 * Stores a member's question or task for a sibling, once per tool call: the same call
 * returns its record again, the same call with another input conflicts.
 */
export function createPeerRequest(service, { type, inv, input, now = Date.now() }) {
  const field = type === "task" ? "task" : "question";
  exact(input, type === "task" ? ["memberId", field, "resultTo"] : ["memberId", field], [
    "memberId",
    field,
  ]);
  const text = textValue(input[field], requestLimits[type]);
  if ("resultTo" in input && !["me", "lead"].includes(input.resultTo))
    throw assistantProblem("invalid");
  const resultTo = input.resultTo || "me";
  textValue(inv?.toolCallId, 256);
  const teams = service.store,
    store = service.requests.store;
  return teams.transaction(() => {
    const caller = peerCaller(service, inv);
    const key = `${caller.attempt?.id || `routine:${caller.routine.sessionKey}`}:${inv.toolCallId}`;
    const hash = fingerprint({ type, memberId: input.memberId, text, resultTo });
    const old = teams.db
      .prepare("SELECT id FROM assistant_team_records WHERE operation_key=?")
      .get(key);
    if (old) {
      const existing = teams.get(old.id);
      if (existing.fingerprint !== hash) throw assistantProblem("conflict", 409);
      return existing;
    }
    if (!peerTurn(service, caller)) throw assistantProblem("peerRequestTurn", 403);
    const { lead, member: sender, assistant: from } = caller;
    const { member, assistant } = peerTarget(service, lead, sender, input.memberId);
    assertPeerLimits(store, sender, member, type);
    loopGuard(service.assistants.store).take(from.id);
    // Questions never write; a task only when the sender's own turn may.
    const peerWrites = type === "task" ? peerWriteOrigin(service, caller) : null;
    return teams.insert(
      {
        id: randomUUID(),
        kind: requestKind,
        revision: 1,
        type,
        parentAssistantId: lead.id,
        // The lead's chat only takes notes of it; the answer goes to the sender.
        parentConversationId:
          mainConversation(service.assistants.store, lead.id)?.id ?? null,
        parentRequestId: null,
        parentAttemptId: null,
        leadName: lead.name,
        memberId: member.id,
        memberAssistantId: member.assistantId,
        memberName: assistant.name,
        fromMemberId: sender.id,
        fromAssistantId: from.id,
        fromName: from.name,
        fromConversationId: caller.conversation.id,
        fromAttemptId: caller.attempt?.id ?? null,
        resultTo,
        text,
        // Never the owner's or a Telegram origin: the sender's own words only.
        origin: { kind: "peer", fromMemberId: sender.id },
        ownerProof: null,
        ...(peerWrites ? { peerWrites } : {}),
        // Fixed at creation: the receiver's access follows who started the chain.
        leadScope: peerLeadScope(caller),
        writeAllowed: type === "task" && !!peerWrites,
        // A task gets the team task deadline, a question the member time limit.
        runTimeoutMinutes:
          type === "task"
            ? taskRunTimeoutMinutes
            : teams.policy(lead.id).runTimeoutMinutes,
        phase: "queued",
        fingerprint: hash,
        delivery: null,
        createdAt: new Date(now).toISOString(),
      },
      key,
    );
  });
}
