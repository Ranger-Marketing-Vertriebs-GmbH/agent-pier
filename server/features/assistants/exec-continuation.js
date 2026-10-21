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
//   (`isHeartbeat`) in this session (HeartbeatRuns), and it is not that turn's run.
//   The run is hidden from the Control UI, so its events reach AgentPier only through
//   the chat's `sessions.messages.subscribe` (conversation-open.js);
// - the hook names the calling run (native writes; a workspace call has no run id
//   and needs exactly one such run in the session);
// - the session's raw transcript (`sessions.get`, a bounded tail) shows that turn's
//   own message (`<attempt id>:user`) and after it only exec completions, each of
//   which reports only processes that turn itself started in the background (its
//   exec results with `status: "running"` and their `sessionId`) and no process of
//   any other turn: a foreground exec, a command of a forwarded, routine or other
//   turn, an image_generate result, a reminder or a heartbeat poll refuses.
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

// Refusals are logged once per session, run and reason, with a code only: never a
// path, the transcript or the command's output.
const logged = new Set();
function refuse(bridge, input, code) {
  const key = `${input.sessionKey}\u0000${input.runId ?? ""}\u0000${code}`;
  if (!logged.has(key)) {
    if (logged.size > 1000) logged.clear();
    logged.add(key);
    (bridge.warn || console.warn)(
      `Exec completion continuation refused for ${String(input.agentId).slice(0, 80)} (${code}).`,
    );
  }
  return null;
}

/**
 * The owner turn a run of a session without an attempt may continue, from
 * AgentPier's own records only: `{ agent, conversation, attempt, runId }` or null.
 * Without `runId` (a workspace call: its context names no run), the session must
 * have exactly one such run; a native write always names its run (continuationWrite).
 */
export function continuationSource(bridge, input) {
  const { agentId, sessionKey, runId } = input;
  try {
    const { store, ledger, heartbeatRuns } = bridge.assistants;
    const agent = bridge.agentOf(agentId);
    if (
      !agent ||
      agent.archivedAt ||
      (agent.teamMemberId && agent.lifetime !== "permanent")
    )
      return refuse(bridge, input, "AGENT");
    const conversation = store.conversationOfSession(sessionKey);
    if (
      conversation?.assistantId !== agent.id ||
      conversation.userReleased ||
      bridge.bound(sessionKey).length
    )
      return refuse(bridge, input, "CHAT");
    const request = ledger.requests(conversation.id).at(-1);
    const attempt = request && ledger.attemptFor(request.id);
    if (attempt?.state !== "completed" || attempt.reviewedAt)
      return refuse(bridge, input, "REQUEST");
    if (!directTurn(bridge.teams?.store?.context?.(request.id), agent))
      return refuse(bridge, input, "ORIGIN");
    const age = bridge.now() - Date.parse(attempt.createdAt);
    if (!(age >= 0 && age <= continuationWindowMs))
      return refuse(bridge, input, "WINDOW");
    const runs = heartbeatRuns?.live(sessionKey) || [];
    const run =
      runId === undefined
        ? runs.length === 1 && runs[0]
        : runs.find((r) => r.runId === runId);
    if (!run || [attempt.id, attempt.runtimeRunId].includes(run.runId))
      return refuse(bridge, input, "RUN");
    return { agent, conversation, attempt, runId: run.runId, run };
  } catch (error) {
    return refuse(bridge, input, `ERROR ${error?.code || error?.name || "unknown"}`);
  }
}

const toolResultOnly = (content) =>
  Array.isArray(content) &&
  content.length > 0 &&
  content.every((b) => ["toolResult", "tool_result"].includes(b?.type));
const isUser = (m) => m?.role === "user" && !toolResultOnly(m.content);
const isCompletion = (m) =>
  m.provenance?.kind === "internal_system" && m.provenance.sourceTool === "exec";
const timeOf = (m) =>
  Number.isFinite(m.timestamp) ? m.timestamp : m.__openclaw?.recordTimestampMs;
// A backgrounded exec: OpenClaw's result of an `exec` call that returned while the
// command keeps running names its process session (`details.sessionId`); a
// foreground command returns `completed` and never wakes the session.
const background = (m) =>
  m?.role === "toolResult" &&
  m.toolName === "exec" &&
  m.details?.status === "running" &&
  typeof m.details.sessionId === "string" &&
  m.details.sessionId
    ? m.details.sessionId
    : null;

// OpenClaw 2026.10.3 shows the model the completed processes in the completion's
// prompt projection (heartbeat-events-filter buildExecEventPrompt): one line per
// process, `Exec <status> (<first 8 characters of its session>, <exit>)`, then
// ` :: <output>` folded to one line, or ` without captured stdout/stderr.`.
const detailsStart = "The command completion details are:\n\n";
const detailsEnd = "\n\nTreat this completion";
const processLine =
  /^Exec [a-z]+ \(([A-Za-z0-9_-]{1,8}), [^)\n]*\)(?: :: .*| without captured stdout\/stderr\.)?$/;
/**
 * The process ids a completion message reports, or null when they cannot all be
 * read: another prompt (no output, delivery off), a truncated list or any line
 * that is not a process line.
 */
export function completedProcesses(message) {
  const text = message?.__openclaw?.modelPromptProjection?.text;
  if (typeof text !== "string") return null;
  const start = text.indexOf(detailsStart);
  const end = start < 0 ? -1 : text.indexOf(detailsEnd, start + detailsStart.length);
  if (end < 0) return null;
  const lines = text
    .slice(start + detailsStart.length, end)
    .split("\n")
    .filter((line) => line.trim());
  const ids = lines.map((line) => processLine.exec(line)?.[1]);
  return ids.length && ids.every(Boolean) ? ids : null;
}

/**
 * Why raw transcript messages (oldest first) do not prove that their trailing exec
 * completions report only commands the attempt's own turn started in the
 * background, inside the window; null when they do.
 */
export function completionRefusal(messages, attempt) {
  if (!Array.isArray(messages)) return "TRANSCRIPT";
  const keys = [attempt.id, attempt.runtimeRunId].filter(Boolean);
  const own = messages.findLastIndex((m) => isUser(m) && keys.includes(turnKey(m)));
  if (own < 0) return "OWNER_TURN";
  const next = messages.findIndex((m, i) => i > own && isUser(m));
  if (next < 0) return "NO_COMPLETION";
  const users = messages.slice(next).filter(isUser);
  if (!users.every(isCompletion)) return "NOT_COMPLETION";
  // The turn's own background commands, and every other one the page shows.
  const owned = [],
    foreign = [];
  messages.forEach((m, i) => {
    const id = background(m);
    const run = m?.__openclaw?.runId;
    if (!id) return;
    if (i > own && i < next && (typeof run !== "string" || keys.includes(run)))
      owned.push(id);
    else foreign.push(id);
  });
  for (const message of users) {
    const ids = completedProcesses(message);
    if (!ids) return "PROCESSES";
    for (const id of ids)
      if (!owned.some((s) => s.startsWith(id)) || foreign.some((s) => s.startsWith(id)))
        return "PROCESS";
  }
  const start = Date.parse(attempt.createdAt);
  const at = timeOf(users.at(-1));
  return Number.isFinite(at) && at >= start && at - start <= continuationWindowMs
    ? null
    : "WINDOW";
}
/** True when the messages prove the completion (completionRefusal). */
export const completionEvidence = (messages, attempt) =>
  completionRefusal(messages, attempt) === null;

// `sessions.get` returns only the newest `limit` messages and does not page: a long
// owner turn reads a larger tail, bounded; an owner turn further back stays refused.
const transcriptLimits = [200, 1000];

/** True when the session's transcript proves the source's run an exec completion. */
export async function continuationProven(bridge, source, input) {
  const { run, attempt } = source;
  if (run.proof === attempt.id) return true;
  if (run.unreachable === attempt.id) return false;
  const client = bridge.assistants.runtime?.client;
  if (!client?.ready) return refuse(bridge, input, "GATEWAY") ?? false;
  const keys = [attempt.id, attempt.runtimeRunId].filter(Boolean);
  let messages;
  for (const limit of transcriptLimits) {
    try {
      messages = (await client.call("sessions.get", { key: input.sessionKey, limit }))
        ?.messages;
    } catch (error) {
      return refuse(bridge, input, `READ ${error?.code || "failed"}`) ?? false;
    }
    if (
      !Array.isArray(messages) ||
      messages.length < limit ||
      messages.some((m) => isUser(m) && keys.includes(turnKey(m)))
    )
      break;
  }
  const code = completionRefusal(messages, attempt);
  // The transcript only grows: an owner turn beyond the bound is never reached.
  if (code === "OWNER_TURN") run.unreachable = attempt.id;
  if (code) return refuse(bridge, input, code) ?? false;
  // Nothing changed while the transcript was read.
  const again = continuationSource(bridge, { ...input, runId: source.runId });
  if (again?.attempt.id !== attempt.id) return false;
  run.proof = attempt.id;
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
 * at once, or a promise of the proof. The hook must name its run (OpenClaw
 * 2026.10.3 always does): a write without one never continues anything. A shared
 * agent's memory notes it like the owner turn's own write would.
 */
export function continuationWrite(bridge, input) {
  if (typeof input.runId !== "string" || !input.runId)
    return !!refuse(bridge, input, "NO_RUN_ID");
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
