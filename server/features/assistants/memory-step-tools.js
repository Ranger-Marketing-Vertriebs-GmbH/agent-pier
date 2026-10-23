import { assistantProblem, textValue } from "./assistant-validation.js";
import { memoryStep } from "./memory-write-policy.js";

/**
 * The only tools a memory step (memory-write-policy.js memoryStep) runs: OpenClaw's
 * memory search and read, file reads, and write and edit, which the write guard
 * limits to the agent's own memory (memoryStepWrite). Every other tool, a future one
 * included, is refused while the step runs (team-plugin/tool-guard.js stepCall).
 */
export const memoryStepTools = ["memory_search", "memory_get", "read", "write", "edit"];
const running = new Set(["pending", "accepted", "running"]);

// The turns a call may belong to: its session's, or without a session every active
// turn of the calling agent.
function turns(bridge, { agentId, sessionKey }) {
  if (typeof sessionKey === "string") return bridge.bound(sessionKey);
  const { ledger, store } = bridge.assistants;
  // An attempt whose request, chat or agent is gone belongs to no agent: skipped.
  return ledger.pending().filter((a) => {
    try {
      const chat = store.getConversation(ledger.getRequest(a.requestId).conversationId);
      return store.getAssistant(chat.assistantId)?.runtimeAgentId === agentId;
    } catch {
      return false;
    }
  });
}

/**
 * Whether a tool call runs in a memory step. Its run decides when the call names a
 * known run of the session; otherwise the session's oldest active turn, the one
 * OpenClaw runs first (a step queued behind an owner turn takes nothing from it).
 * A call without a session, or of a run outside the session, counts as the step
 * whenever the agent or session has one.
 */
export function memoryStepSession(bridge, input) {
  const bound = turns(bridge, input);
  const step = (a) => memoryStep(bridge.teams.store?.context(a.requestId));
  if (!bound.some(step)) return false;
  if (typeof input.sessionKey !== "string") return true;
  const run = bridge.assistants.ledger.attemptForRun(input.runId);
  if (run) {
    const own = bound.find((a) => a.id === run.id);
    return own ? step(own) : true;
  }
  const first = bound.find((a) => running.has(a.state));
  return !first || step(first);
}

/** The plugin's question for every tool call: refused only in a memory step. */
export function stepPolicy(bridge, input) {
  const keys = ["agentId", "sessionKey", "toolName", "runId"];
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).some((k) => !keys.includes(k))
  )
    throw assistantProblem("invalid");
  for (const k of ["agentId", "toolName"]) textValue(input[k], 4096);
  for (const k of ["sessionKey", "runId"])
    if (k in input) textValue(input[k], k === "runId" ? 512 : 4096);
  if (bridge.closed) return { allow: false };
  return {
    allow: memoryStepTools.includes(input.toolName) || !memoryStepSession(bridge, input),
  };
}
