// What OpenClaw's own run after a background command may change. An owner turn that
// starts a long `exec` (a render, a build) ends while the command keeps running; when
// it exits, OpenClaw 2026.10.3 (`tools.exec.notifyOnExit`, on by default) wakes the
// same session through its heartbeat runner with a hidden user message
// `[OpenClaw exec completion]` and the input provenance
// `{ kind: "internal_system", sourceTool: "exec" }` (heartbeat-runner-run,
// internal-turn-source). That run has no AgentPier attempt. Its writes continue the
// owner turn that started the command, with that turn's limits, only when AgentPier
// proves all of this (continuationSource, processRefusal):
// - the session is a chat of the calling agent, which is active and no temporary
//   task member;
// - the chat's latest ledger request is a completed direct turn (directTurn, read
//   live: a restricted user who lost the agent gets nothing) at most
//   `continuationWindowMs` ago, and no newer request exists;
// - the call names its run (the write hook's `runId`; a workspace call the run of
//   its tool call), and the Gateway's agent events mark that run as heartbeat-driven
//   (`isHeartbeat`) in this session (HeartbeatRuns), and it is not that turn's run.
//   The run is hidden from the Control UI, so its events reach AgentPier only through
//   the chat's `sessions.messages.subscribe` (conversation-open.js);
// - the Gateway's own record of the session (team-plugin/exec-processes.js, sent
//   with the call) is complete and shows that the run's prompt is an exec
//   completion listing only processes whose every possible owner, by the first
//   eight characters OpenClaw reports, is that turn's own run: each listed id must
//   be the prefix of at least one background process the turn started, and of no
//   process of any other run in that session. A foreground exec, a command of a
//   forwarded, routine or other turn, an approval's command, a reminder, a heartbeat
//   poll or an unreadable list refuses.
// The command's output stays data: it never proves an owner request, unlocks SSH,
// grants, routines or other owner-only switches, and project folders take only file
// actions (workspace-calls.js). Each write is audited with `via: "exec-completion"`.
import { directTurn } from "./memory-write-policy.js";
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
// path, the prompt or the command's output.
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
 * The owner turn the named run of a session without an attempt may continue, from
 * AgentPier's own records: `{ agent, conversation, attempt, runId, run }` or null.
 */
export function continuationSource(bridge, input) {
  const { agentId, sessionKey, runId } = input;
  try {
    if (typeof runId !== "string" || !runId) return refuse(bridge, input, "NO_RUN_ID");
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
    const run = (heartbeatRuns?.live(sessionKey) || []).find((r) => r.runId === runId);
    if (!run || [attempt.id, attempt.runtimeRunId].includes(run.runId))
      return refuse(bridge, input, "RUN");
    return { agent, conversation, attempt, runId, run };
  } catch (error) {
    return refuse(bridge, input, `ERROR ${error?.code || error?.name || "unknown"}`);
  }
}

const maxProcesses = 256;
const shortText = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;
/** The Gateway's evidence as the plugin sends it (exec-processes.js), or null. */
export function execEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { complete, processes, completion } = value;
  if (
    typeof complete !== "boolean" ||
    !Array.isArray(processes) ||
    processes.length > maxProcesses ||
    !processes.every((p) => shortText(p?.id, 128) && shortText(p?.runId, 512))
  )
    return null;
  if (
    completion !== null &&
    (!completion ||
      !shortText(completion.runId, 512) ||
      !Number.isFinite(completion.at) ||
      !(
        completion.ids === null ||
        (Array.isArray(completion.ids) &&
          completion.ids.length <= maxProcesses &&
          completion.ids.every((id) => shortText(id, 8)))
      ))
  )
    return null;
  return {
    complete,
    processes: processes.map(({ id, runId }) => ({ id, runId })),
    completion: completion && {
      runId: completion.runId,
      ids: completion.ids,
      at: completion.at,
    },
  };
}

/**
 * Why the Gateway's evidence does not prove that the run's completion reports only
 * processes the attempt's own run started; null when it does. OpenClaw reports
 * `id.slice(0, 8)`, so a reported id stands for every process with that exact
 * beginning, and all of them must be the turn's.
 */
export function processRefusal(evidence, attempt, runId) {
  if (!evidence) return "EVIDENCE";
  if (evidence.complete !== true) return "UNTRACKED";
  const completion = evidence.completion;
  if (!completion || completion.runId !== runId) return "NOT_COMPLETION";
  if (!completion.ids?.length) return "PROCESSES";
  const keys = [attempt.id, attempt.runtimeRunId].filter(Boolean);
  for (const id of completion.ids) {
    const candidates = evidence.processes.filter((p) => p.id.slice(0, 8) === id);
    if (!candidates.length || candidates.some((p) => !keys.includes(p.runId)))
      return "PROCESS";
  }
  const start = Date.parse(attempt.createdAt);
  return completion.at >= start && completion.at - start <= continuationWindowMs
    ? null
    : "WINDOW";
}

/** The source of a call whose evidence proves it, or null (logged). */
function provenSource(bridge, input) {
  const source = continuationSource(bridge, input);
  if (!source) return null;
  const code = processRefusal(execEvidence(input.exec), source.attempt, source.runId);
  return code ? refuse(bridge, input, code) : source;
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
 * A native write in a session without an attempt (TeamBridge.writeAllowed). A
 * shared agent's memory notes it like the owner turn's own write would.
 */
export function continuationWrite(bridge, input) {
  const source = provenSource(bridge, input);
  if (!source) return false;
  audit(bridge.assistants, source, input);
  if (isShared(source.agent) && isMemory(input.path))
    bridge.noteShared(`${source.attempt.id}:shared-write`, source.conversation.id);
  return true;
}

/** A workspace ticket's binding for such a run, or null (TeamBridge.prepare). */
export function continuationBinding(bridge, input) {
  if (input.action !== "workspace") return null;
  const source = provenSource(bridge, input);
  return source && { attemptId: source.attempt.id, runId: source.runId };
}

/** Re-checks a continuation ticket on every step (TeamBridge.valid); throws. */
export function assertContinuation(bridge, record) {
  const source = provenSource(bridge, { ...record, runId: record.continuation.runId });
  if (
    record.action !== "workspace" ||
    source?.attempt.id !== record.continuation.attemptId
  )
    throw assistantProblem("invalid", 403);
  return record;
}
