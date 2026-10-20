import {
  flushDates,
  flushRunOf,
  flushSessionAgent,
  flushTarget,
} from "./memory-flushes.js";
import { inheritsFromLead } from "./native-capabilities.js";

/**
 * A person's own turn: the owner's, his paired Telegram chat's or a restricted
 * user's in her own chat, never forwarded content. Such a turn may change memory.
 */
export const directOrigin = (origin) =>
  ["owner", "telegram", "user"].includes(origin?.kind) && !origin.forwarded;
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
      if (bridge.routineWrite(source)) return [{ flush, allow: true }];
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
        allow:
          current &&
          [attempt.id, attempt.runtimeRunId].includes(flush.runId) &&
          // A task member's own memory takes its flush in any of its turns.
          (directOrigin(origin) || inheritsFromLead(parent)),
      },
    ];
  });
}

/**
 * OpenClaw's pre-compaction memory flush runs in its own internal session
 * (memory-flushes.js); its one write is the append-only day note. It writes for
 * the run it interrupts: a direct turn (directOrigin: the owner, his paired Telegram
 * chat or a restricted user), or a
 * routine's run, of the same agent, never a forwarded, lead-requested or other
 * turn. The key must name the run the hook reports, the note must be today's or
 * yesterday's, and the first flush session that writes owns the flush; anything
 * else, or more than one flush of the agent at a time, is refused.
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
  return true;
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
    return current && parent.runtimeAgentId === input.agentId && directOrigin(origin);
  });
  return turns.length === 1
    ? { attempt: turns[0], key: `flush:${input.runId || input.sessionKey}` }
    : null;
}

const refusalReason = (origin) =>
  origin?.kind === "lead-request"
    ? "lead-request"
    : origin?.forwarded
      ? "forwarded"
      : origin?.kind === "team-member" || !origin?.kind || origin.kind === "unknown"
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
  if (parent.runtimeAgentId !== input.agentId || (!flush && directOrigin(origin))) return;
  const reason = flush ? "flush" : refusalReason(origin);
  const added = notes.record({
    key: target.key || `${attempt.id}:${reason}`,
    conversationId: bridge.assistants.ledger.getRequest(attempt.requestId).conversationId,
    reason,
  });
  if (added) bridge.assistants.changed?.();
}
