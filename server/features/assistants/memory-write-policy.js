import {
  flushDates,
  flushRunOf,
  flushSessionAgent,
  flushTarget,
} from "./memory-flushes.js";
import { inheritsFromLead } from "./native-capabilities.js";
import { ownMemoryTarget } from "./lead-request-writes.js";
import { isShared, memberLevel } from "../users/user-access.js";

/**
 * A person's own turn: the owner's, his paired Telegram chat's or a restricted
 * user's in her own chat, never forwarded content. Such a turn may change memory.
 */
export const directOrigin = (origin) =>
  ["owner", "telegram", "user"].includes(origin?.kind) && !origin.forwarded;
/**
 * A direct turn on this agent: a user's turn counts only while she is still one of
 * its users (memberLevel, read live), like her folder access (workspace-calls.js).
 */
export const directTurn = (origin, agent) =>
  directOrigin(origin) && (origin.kind !== "user" || !!memberLevel(agent, origin.userId));
/**
 * The memory step before a summary (long-chats.js): a hidden turn only AgentPier
 * sends, with context kind `memory-step`, never an owner quote. It is no direct turn:
 * it writes the agent's own memory (MEMORY.md and notes below memory/, never the
 * copy of a lead's memory, ownMemoryTarget) and nothing else; on a shared agent its
 * one shared memory, which all its users and the owner read (team-bridge.js noteShared).
 */
export const memoryStep = (context) => context?.kind === "memory-step";
export const memoryStepWrite = (context, { agent, root, path }) =>
  memoryStep(context) && !!agent && ownMemoryTarget(root, agent.runtimeAgentId, path);
/**
 * Whether a native write of this bound turn is admitted: a direct turn, a task
 * member's own memory in any turn it works (never the copy of its lead's memory or
 * anything else, member-memory.js), a memory step's own memory, or a task the owner
 * asked for or approved in exactly its own member turn.
 */
export function turnWrite(bridge, { attempt, parent, origin, current }, input) {
  const root = bridge.assistants.runtime?.paths?.workspaces;
  // A memory step changes its memory with write and edit only (memory-step-tools.js).
  if (memoryStep(origin) && !["write", "edit"].includes(input.toolName)) return false;
  return (
    current &&
    (directTurn(origin, parent) ||
      (inheritsFromLead(parent) && ownMemoryTarget(root, input.agentId, input.path)) ||
      memoryStepWrite(origin, { agent: parent, root, path: input.path }) ||
      (origin?.kind === "lead-request" &&
        !!bridge.teams.requests?.mayWrite(
          origin.requestId,
          attempt.id,
          parent.id,
          input.path,
        )))
  );
}
// Refused flush writes are logged once per flush session (bounded).
const logged = new Set();
function diagnose(bridge, input, code) {
  if (logged.has(input.sessionKey)) return;
  if (logged.size > 1000) logged.clear();
  logged.add(input.sessionKey);
  (bridge.warn || console.warn)(
    `Memory flush write refused for ${input.agentId} (${code}): ${input.path}`,
  );
}

// The flush sources of this agent: each running flush with its decision, or no
// entry when the source is not this agent's.
function sources(bridge, input) {
  return (bridge.assistants.memoryFlushes?.active() || []).flatMap((flush) => {
    const matches = bridge.bound(flush.sessionKey);
    if (matches.length > 1) return [{ flush, allow: false }];
    if (!matches.length) {
      const source = { agentId: input.agentId, sessionKey: flush.sessionKey };
      // A routine's flush writes like the routine itself, on a shared agent too.
      if (bridge.routineWrite(source))
        return [{ flush, source, agent: bridge.agentOf(input.agentId), allow: true }];
      return flush.sessionKey.startsWith(`agent:${input.agentId}:`)
        ? [{ flush, allow: false }]
        : [];
    }
    const { attempt, parent, origin, current } = bridge.turn(matches[0], input.agentId);
    if (parent.runtimeAgentId !== input.agentId) return [];
    return [
      {
        flush,
        attempt,
        agent: parent,
        allow:
          current &&
          [attempt.id, attempt.runtimeRunId].includes(flush.runId) &&
          // A task member's own memory takes its flush in any of its turns, and a
          // memory step its own agent's (memoryStep).
          (directTurn(origin, parent) || inheritsFromLead(parent) || memoryStep(origin)),
      },
    ];
  });
}

/**
 * OpenClaw's pre-compaction memory flush runs in its own internal session
 * (memory-flushes.js); its one write is the append-only day note. It writes for
 * the run it interrupts: a direct turn (directOrigin: the owner, his paired Telegram
 * chat or a restricted user on her agent), a memory step or a routine's run, of the
 * same agent, never a forwarded, lead-requested or other turn. The key must name the
 * run the hook reports, the note must be today's or yesterday's, and the first flush
 * session that writes owns the flush; anything else, or more than one flush of the
 * agent at a time, is refused. On a shared agent it writes the one shared memory like
 * a saved write: the flushing chat (a routine's: its chat) notes "shared-write".
 */
export function flushWrite(bridge, input) {
  const runId = flushRunOf(input.sessionKey);
  const shape =
    flushSessionAgent(input.sessionKey) === input.agentId &&
    input.toolName === "write" &&
    flushTarget.test(input.path) &&
    !!runId &&
    input.runId === runId;
  if (!shape) return (diagnose(bridge, input, "FLUSH_SHAPE"), false);
  if (!flushDates(bridge.now(), bridge.flushTimeZone?.()).includes(input.path))
    return (diagnose(bridge, input, "FLUSH_DATE"), false);
  const found = sources(bridge, input);
  if (found.length !== 1 || !found[0].allow)
    return (
      diagnose(bridge, input, found.length ? "FLUSH_ORIGIN" : "FLUSH_UNREPORTED"),
      false
    );
  if (!bridge.assistants.memoryFlushes.pin(found[0].flush, input.sessionKey))
    return (diagnose(bridge, input, "FLUSH_SESSION"), false);
  if (isShared(found[0].agent)) noteSharedFlush(bridge, found[0]);
  return true;
}

// The flushing chat of a shared agent's saved flush, keyed as its run's own writes.
function noteSharedFlush(bridge, { attempt, source }) {
  if (attempt)
    return bridge.noteShared(
      `${attempt.id}:shared-write`,
      bridge.assistants.ledger.getRequest(attempt.requestId).conversationId,
    );
  const conversationId = bridge.routineRun(source)?.conversation?.id;
  if (conversationId)
    bridge.noteShared(`${source.sessionKey}:shared-write`, conversationId);
}

// The one conversation a refused flush write belongs to: the reported flush's
// source, or, when the Gateway reported no flush of the agent at all (a changed
// runtime), the agent's single active owner turn. A reported routine or other
// source never falls back to an owner conversation.
function flushTurn(bridge, input) {
  const all = sources(bridge, input);
  if (all.length)
    return all.length === 1 && all[0].attempt
      ? { attempt: all[0].attempt, key: `flush:${all[0].flush.runId}` }
      : null;
  const turns = bridge.assistants.ledger.pending().filter((a) => {
    if (!["pending", "accepted", "running"].includes(a.state)) return false;
    const { parent, origin, current } = bridge.turn(a, input.agentId);
    return (
      current && parent.runtimeAgentId === input.agentId && directTurn(origin, parent)
    );
  });
  return turns.length === 1
    ? { attempt: turns[0], key: `flush:${input.runId || input.sessionKey}` }
    : null;
}

// A memory step writes only its own agent's memory (memoryStepWrite).
const refusalReason = (origin) =>
  memoryStep(origin)
    ? "memory-step"
    : origin?.kind === "lead-request"
      ? origin.peer
        ? "peer-request"
        : "lead-request"
      : origin?.forwarded
        ? "forwarded"
        : ["team-member", "user", "unknown"].includes(origin?.kind) || !origin?.kind
          ? "not-owner"
          : "automatic";

/**
 * A refused write to MEMORY.md or memory/ shows in the turn's chat as a quiet note
 * (memory-notes.js), once per turn and reason, so neither the owner nor the agent's
 * next reply can take it for saved.
 */
export function noteRefusal(bridge, input) {
  const notes = bridge.assistants.memoryNotes;
  if (!notes) return;
  const flush = !!flushSessionAgent(input.sessionKey);
  let target;
  if (flush) target = flushTurn(bridge, input);
  else {
    const bound = bridge.bound(input.sessionKey);
    target = bound.length === 1 ? { attempt: bound[0] } : null;
  }
  if (!target) return;
  const { attempt, parent, origin } = bridge.turn(target.attempt, input.agentId);
  if (parent.runtimeAgentId !== input.agentId || (!flush && directTurn(origin, parent)))
    return;
  const reason = flush ? "flush" : refusalReason(origin);
  const added = notes.record({
    key: target.key || `${attempt.id}:${reason}`,
    conversationId: bridge.assistants.ledger.getRequest(attempt.requestId).conversationId,
    reason,
  });
  if (added) bridge.assistants.changed?.();
}
