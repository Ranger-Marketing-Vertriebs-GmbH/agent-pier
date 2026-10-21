// What OpenClaw's own run after a background command may change. An owner turn that
// starts a long `exec` (a render, a build) ends while the command keeps running; when
// it exits, OpenClaw 2026.10.3 (`tools.exec.notifyOnExit`, on by default) wakes the
// same session through its heartbeat runner with a hidden user message
// `[OpenClaw exec completion]` and the input provenance
// `{ kind: "internal_system", sourceTool: "exec" }` (heartbeat-runner-run,
// internal-turn-source). That run has no AgentPier attempt. Its writes continue the
// owner turn that started the command, with that turn's limits, only when AgentPier
// itself proves all of this (continuationSource, continuationProven):
// - the session is a chat of the calling agent, which is active and no temporary
//   task member;
// - the chat's latest ledger request is a completed direct turn (directTurn, read
//   live: a restricted user who lost the agent gets nothing) at most
//   `continuationWindowMs` ago, and no newer request exists;
// - the Gateway's agent events mark the calling run as heartbeat-driven
//   (`isHeartbeat`) in this session (HeartbeatRuns), and it is not that turn's run;
// - the session's raw transcript (`sessions.get`) shows that turn's own message
//   (`<attempt id>:user`), an `exec` call after it, and after that only exec
//   completions: an image_generate result, a reminder, a heartbeat poll or anything
//   else in between refuses.
// The command's output stays data: it never proves an owner request, unlocks SSH,
// grants, routines or other owner-only switches, and project folders take only file
// actions (workspace-calls.js). Each write is audited with `via: "exec-completion"`.
import { directTurn } from "./memory-write-policy.js";
import { turnKey } from "./message-source.js";
import { assistantProblem } from "./assistant-validation.js";
import { isMemory } from "./lead-request-writes.js";
import { isShared } from "../users/user-access.js";

/** How long after the owner turn its command's completion may still write. */
export const continuationWindowMs = 2 * 3600000;
const maxRuns = 64;

/** The live runs the Gateway marks as heartbeat-driven, by session (agent events). */
export class HeartbeatRuns {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.runs = new Map();
  }
  /** Takes every Gateway `agent` event. */
  observe(payload) {
    const { runId, sessionKey } = payload || {};
    if (typeof runId !== "string" || typeof sessionKey !== "string") return;
    const phase = payload.data?.phase;
    if (
      payload.isHeartbeat === false ||
      (payload.stream === "lifecycle" && ["end", "error"].includes(phase))
    )
      return void this.runs.delete(runId);
    if (payload.isHeartbeat !== true) return;
    const run = this.runs.get(runId);
    if (run && run.sessionKey !== sessionKey) return void this.runs.delete(runId);
    if (!run) this.runs.set(runId, { runId, sessionKey, at: this.now() });
    if (this.runs.size > maxRuns) this.runs.delete(this.runs.keys().next().value);
  }
  /** The run ids live in this session. */
  live(sessionKey) {
    const now = this.now();
    for (const [id, run] of this.runs)
      if (now - run.at > continuationWindowMs) this.runs.delete(id);
    return [...this.runs.values()].filter((r) => r.sessionKey === sessionKey);
  }
  clear() {
    this.runs.clear();
  }
}

/**
 * The owner turn a run of a session without an attempt may continue, from
 * AgentPier's own records only: `{ agent, conversation, attempt, runId }` or null.
 * Without `runId` (a workspace call), the session must have exactly one such run.
 */
export function continuationSource(bridge, { agentId, sessionKey, runId }) {
  try {
    const { store, ledger, heartbeatRuns } = bridge.assistants;
    const agent = bridge.agentOf(agentId);
    if (
      !agent ||
      agent.archivedAt ||
      (agent.teamMemberId && agent.lifetime !== "permanent")
    )
      return null;
    const conversation = store.conversationOfSession(sessionKey);
    if (
      conversation?.assistantId !== agent.id ||
      conversation.userReleased ||
      bridge.bound(sessionKey).length
    )
      return null;
    const request = ledger.requests(conversation.id).at(-1);
    const attempt = request && ledger.attemptFor(request.id);
    if (attempt?.state !== "completed" || attempt.reviewedAt) return null;
    if (!directTurn(bridge.teams?.store?.context?.(request.id), agent)) return null;
    const age = bridge.now() - Date.parse(attempt.createdAt);
    if (!(age >= 0 && age <= continuationWindowMs)) return null;
    const runs = heartbeatRuns?.live(sessionKey) || [];
    const run =
      runId === undefined
        ? runs.length === 1 && runs[0]
        : runs.find((r) => r.runId === runId);
    if (!run || [attempt.id, attempt.runtimeRunId].includes(run.runId)) return null;
    return { agent, conversation, attempt, runId: run.runId, run };
  } catch {
    return null;
  }
}

const toolResultOnly = (content) =>
  Array.isArray(content) &&
  content.length > 0 &&
  content.every((b) => ["toolResult", "tool_result"].includes(b?.type));
const isUser = (m) => m?.role === "user" && !toolResultOnly(m.content);
const isCompletion = (m) =>
  m.provenance?.kind === "internal_system" && m.provenance.sourceTool === "exec";
const callsExec = (m) =>
  m?.role === "assistant" &&
  [
    ...(Array.isArray(m.content) ? m.content : []),
    ...(Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c?.function) : []),
  ].some((b) => b?.name === "exec");
const timeOf = (m) =>
  Number.isFinite(m.timestamp) ? m.timestamp : m.__openclaw?.recordTimestampMs;

/**
 * True when raw transcript messages (oldest first) end in exec completions of a
 * command the attempt's own turn started, inside the window.
 */
export function completionEvidence(messages, attempt) {
  if (!Array.isArray(messages)) return false;
  const keys = [attempt.id, attempt.runtimeRunId].filter(Boolean);
  const own = messages.findLastIndex((m) => isUser(m) && keys.includes(turnKey(m)));
  if (own < 0) return false;
  const after = messages.slice(own + 1);
  const users = after.filter(isUser);
  if (!users.length || !users.every(isCompletion)) return false;
  if (!after.slice(0, after.indexOf(users[0])).some(callsExec)) return false;
  const start = Date.parse(attempt.createdAt);
  const at = timeOf(users.at(-1));
  return Number.isFinite(at) && at >= start && at - start <= continuationWindowMs;
}

/** True when the session's transcript proves the source's run an exec completion. */
export async function continuationProven(bridge, source, input) {
  if (source.run.proof === source.attempt.id) return true;
  const client = bridge.assistants.runtime?.client;
  if (!client?.ready) return false;
  let page;
  try {
    page = await client.call("sessions.get", { key: input.sessionKey, limit: 100 });
  } catch {
    return false;
  }
  if (!completionEvidence(page?.messages, source.attempt)) return false;
  // Nothing changed while the transcript was read.
  const again = continuationSource(bridge, { ...input, runId: source.runId });
  if (again?.attempt.id !== source.attempt.id) return false;
  source.run.proof = source.attempt.id;
  return true;
}

/** One audit record per continuation write: the path, never content. */
function audit(assistants, source, input) {
  try {
    assistants.audit?.append({
      action: "assistant.updated",
      resourceType: "assistant",
      resourceId: source.agent.id,
      source: "system",
      outcome: "success",
      details: {
        kind: "native-write",
        tool: input.toolName,
        filePath: input.path,
        via: "exec-completion",
        sourceAttemptId: source.attempt.id,
      },
    });
  } catch (error) {
    console.error("Exec completion write audit failed:", error?.message);
  }
}

/**
 * A native write in a session without an attempt (TeamBridge.writeAllowed): false
 * at once, or a promise of the proof. A shared agent's memory notes it like the
 * owner turn's own write would.
 */
export function continuationWrite(bridge, input) {
  const source = continuationSource(bridge, input);
  if (!source) return false;
  return continuationProven(bridge, source, input).then((proven) => {
    if (!proven) return false;
    audit(bridge.assistants, source, input);
    if (isShared(source.agent) && isMemory(input.path))
      bridge.noteShared(`${source.attempt.id}:shared-write`, source.conversation.id);
    return true;
  });
}

/** A workspace ticket's binding for such a run, or null (TeamBridge.prepare). */
export function continuationBinding(bridge, input) {
  if (input.action !== "workspace") return null;
  const source = continuationSource(bridge, input);
  return source && { attemptId: source.attempt.id, runId: source.runId };
}

/** Re-checks a continuation ticket on every step (TeamBridge.valid); throws. */
export function assertContinuation(bridge, record) {
  const source = continuationSource(bridge, {
    ...record,
    runId: record.continuation.runId,
  });
  if (
    record.action !== "workspace" ||
    source?.attempt.id !== record.continuation.attemptId
  )
    throw assistantProblem("invalid", 403);
  return record;
}

/** Proves a continuation ticket's run before its call runs (TeamBridge.invoke). */
export async function proveContinuation(bridge, record) {
  if (!record.continuation) return;
  const source = continuationSource(bridge, {
    ...record,
    runId: record.continuation.runId,
  });
  if (
    source?.attempt.id !== record.continuation.attemptId ||
    !(await continuationProven(bridge, source, record))
  )
    throw assistantProblem("invalid", 403);
}
