// What OpenClaw's own run after a background command may change. An owner turn that
// starts a long `exec` (a render, a build) ends while the command keeps running; when
// it exits, OpenClaw (`tools.exec.notifyOnExit`, on by default) runs the same session
// once more without an AgentPier attempt:
// - 2026.10.3 (and 9.9, 9.8, the rollback targets) wakes it through its heartbeat
//   runner with a hidden user message `[OpenClaw exec completion]`; the Gateway's
//   agent events of that run carry `isHeartbeat: true`;
// - 2026.10.7 sends an ordinary event turn (enqueueSessionEventForHost, source
//   "exec") whose prompt is the bare `Exec <status> (<id8>, <exit>) :: <output>`
//   line. Its agent events carry no mark (`isHeartbeat: false`); only the hooks'
//   `ctx.trigger: "event"` (which the team plugin records with the completion as
//   `internal`) and the transcript entry's provenance tell it apart.
// Both write the completion's user entry with the input provenance
// `{ kind: "internal_system", sourceTool: "exec" }`. Its writes, project folder file
// actions and shared files (agentpier_share_file) continue the turn that started the
// command, with that turn's limits, only when AgentPier proves all of this
// (continuationSource, processRefusal, provenSource):
// - the session is a chat of the calling agent, which is active and no temporary
//   task member;
// - the turn is a completed turn that continues the owner's own work (continuedTurn:
//   a direct turn, read live so a restricted user who lost the agent gets nothing, a
//   work-goal continuation, which is recorded as one, or a lead's follow-up on its
//   member's result, member-result-writes.js) at most `continuationWindowMs` ago. It
//   is the chat's latest ledger request, or the one whose run started the reported
//   processes when only completed lead follow-ups on its members' results (proven)
//   and the owner's own direct messages came after it (sourceRequest,
//   AGENTPIER-261: the owner decided neither ends the command's follow-up); any
//   other newer request ends the continuation;
// - the call names its run (the write hook's `runId`; a workspace call the run of
//   its tool call), it is not that turn's run, and either the Gateway's agent events
//   mark it heartbeat-driven in this session (CompletionRuns), or the plugin saw it
//   as an event turn (`completion.internal`) and the session's transcript
//   (`sessions.get`, read once per run) holds its user entry with exactly that exec
//   provenance and the same process lines (transcriptRefusal). The run is hidden
//   from the Control UI, so its events reach AgentPier only through the chat's
//   `sessions.messages.subscribe` (conversation-open.js);
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
// actions (workspace-calls.js). A shared file goes to the source turn's chat, and to
// Telegram only when that turn came from the owner's paired chat (agent-shares.js).
// Each write is audited with `via: "exec-completion"`.
import { directOrigin, directTurn } from "./memory-write-policy.js";
import { assistantProblem } from "./assistant-validation.js";
import { isMemory } from "./lead-request-writes.js";
import { isShared, isUserAgent } from "../users/user-access.js";
import { isDeepStrictEqual } from "node:util";
import { completedProcesses } from "./team-plugin/exec-processes.js";
import { resultTurn } from "./member-result-writes.js";

/** How long after the owner turn its command's completion may still write. */
export const continuationWindowMs = 2 * 3600000;
const maxRuns = 64;
/** The bridge actions a completion run is bound for (TeamBridge.prepare). */
export const continuationActions = new Set(["workspace", "share_file"]);

/**
 * Whether a completed turn's command completion may continue it: a direct turn of
 * this agent (a goal continuation is recorded as the owner's), or a lead's follow-up
 * on its member's result, which the owner decided acts like the lead's own work.
 */
export function continuedTurn(assistants, origin, agent, attemptId) {
  if (directTurn(origin, agent)) return true;
  return (
    origin?.kind === "member-result" &&
    !!resultTurn(assistants, origin.requestId, attemptId)
  );
}

/**
 * The live completion runs, by session: those the Gateway's agent events mark as
 * heartbeat-driven (2026.10.3 and older) and the 2026.10.7 event turns whose
 * transcript entry AgentPier has verified (`admit`).
 */
export class CompletionRuns {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.runs = new Map();
    // Runs seen ending: a verification that returns late admits nothing.
    this.ended = new Set();
    // The transcript read under way per run: concurrent calls share it.
    this.verifying = new Map();
  }
  /** Takes every Gateway `agent` event. */
  observe(payload) {
    const { runId, sessionKey } = payload || {};
    if (typeof runId !== "string" || typeof sessionKey !== "string") return;
    const phase = payload.data?.phase;
    const run = this.runs.get(runId);
    if (payload.stream === "lifecycle" && ["end", "error"].includes(phase)) {
      this.ended.add(runId);
      if (this.ended.size > maxRuns) this.ended.delete(this.ended.values().next().value);
      return void this.runs.delete(runId);
    }
    // A run reported for another session is no longer trusted.
    if (run && run.sessionKey !== sessionKey) return void this.runs.delete(runId);
    // 2026.10.7 marks no event of an event turn: only a heartbeat run loses its mark.
    if (payload.isHeartbeat === false)
      return void (run?.kind === "heartbeat" && this.runs.delete(runId));
    if (payload.isHeartbeat !== true || run) return;
    this.add({ runId, sessionKey, kind: "heartbeat" });
  }
  /** A 2026.10.7 event turn whose transcript entry proved it (provenSource). */
  admit(runId, sessionKey) {
    if (this.ended.has(runId) || this.runs.has(runId)) return;
    this.add({ runId, sessionKey, kind: "event" });
  }
  add({ runId, sessionKey, kind }) {
    this.runs.set(runId, { runId, sessionKey, at: this.now(), kind });
    if (this.runs.size > maxRuns) this.runs.delete(this.runs.keys().next().value);
  }
  /** The runs live in this session. */
  live(sessionKey) {
    const now = this.now();
    for (const [id, run] of this.runs)
      if (now - run.at > continuationWindowMs) this.runs.delete(id);
    return [...this.runs.values()]
      .filter((r) => r.sessionKey === sessionKey)
      .map(({ runId, sessionKey: key, at }) => ({ runId, sessionKey: key, at }));
  }
  clear() {
    this.runs.clear();
    this.ended.clear();
    this.verifying.clear();
  }
}

// The plugin's completion of a 2026.10.7 event turn for this very call, or null.
function eventTurn(input) {
  const completion = execEvidence(input.exec)?.completion;
  return completion?.internal === true && completion.runId === input.runId
    ? completion
    : null;
}

// A refusal is logged once per session, run and reason, with a code only (never a
// path, the prompt or the command's output), and only for a completion run of that
// session (a live one, or an event turn the plugin reports): an ordinary refused
// write elsewhere is not a continuation and stays quiet.
const logged = new Set();
function refuse(bridge, input, code) {
  const candidate =
    bridge.assistants?.completionRuns
      ?.live(input.sessionKey)
      .some((r) => r.runId === input.runId) || !!eventTurn(input);
  const key = `${input.sessionKey}\u0000${input.runId}\u0000${code}`;
  if (candidate && !logged.has(key)) {
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
    const { store, ledger, completionRuns } = bridge.assistants;
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
    const request = sourceRequest(bridge, input, conversation.id, agent);
    const attempt = request && ledger.attemptFor(request.id);
    if (attempt?.state !== "completed" || attempt.reviewedAt)
      return refuse(bridge, input, "REQUEST");
    const origin = bridge.teams?.store?.context?.(request.id);
    if (!continuedTurn(bridge.assistants, origin, agent, attempt.id))
      return refuse(bridge, input, "ORIGIN");
    const age = bridge.now() - Date.parse(attempt.createdAt);
    if (!(age >= 0 && age <= continuationWindowMs))
      return refuse(bridge, input, "WINDOW");
    // A 2026.10.7 event turn not yet verified stays pending (provenSource).
    const run =
      (completionRuns?.live(sessionKey) || []).find((r) => r.runId === runId) ||
      (eventTurn(input) &&
        !completionRuns?.ended.has(runId) && {
          runId,
          sessionKey,
          at: bridge.now(),
          pending: true,
        });
    // Never a ledger turn's own run (the source's or a later follow-up's).
    if (
      !run ||
      [attempt.id, attempt.runtimeRunId].includes(run.runId) ||
      ledger.attemptForRun(run.runId)
    )
      return refuse(bridge, input, "RUN");
    return { agent, conversation, attempt, runId, run };
  } catch (error) {
    return refuse(bridge, input, `ERROR ${error?.code || error?.name || "unknown"}`);
  }
}

/**
 * The request a completion run may continue: the chat's latest one, or the earlier
 * request whose attempt started every process the completion reports when each
 * request after it completed unreviewed and is either a lead's follow-up on its
 * member's result that AgentPier submitted (resultTurn), or the owner's own direct
 * message (in the chat or from his paired Telegram chat, never forwarded, never on a
 * user agent). The owner decided neither ends the command's follow-up, which keeps
 * the source turn's rights, chat and Telegram target. Forwarded content, a
 * restricted user's message, reminders, hooks, lead tasks and every other turn still
 * end it.
 */
function sourceRequest(bridge, input, conversationId, agent) {
  const { ledger } = bridge.assistants;
  const latest = ledger.latestRequest(conversationId);
  const starter = starterAttempt(ledger, execEvidence(input.exec));
  if (!latest || !starter || starter.requestId === latest.id) return latest;
  const request = ledger.getRequest(starter.requestId);
  if (request.conversationId !== conversationId) return latest;
  // By row, not time: a clock step back never hides a newer owner message.
  const later = ledger.requestsAfter(conversationId, request.id);
  return later.length && later.every((r) => laterTurn(bridge, r, agent))
    ? request
    : latest;
}
// The one attempt whose run started the processes a completion reports, or null.
function starterAttempt(ledger, evidence) {
  const ids = evidence?.completion?.ids;
  if (!evidence?.complete || !ids?.length) return null;
  const runs = new Set(
    evidence.processes.filter((p) => ids.includes(p.id.slice(0, 8))).map((p) => p.runId),
  );
  return runs.size === 1 ? ledger.attemptForRun([...runs][0]) : null;
}
// A completed, unreviewed turn after the source that does not end its continuation:
// a lead's follow-up on its member's result that AgentPier sent, or the owner's own
// direct message (directOrigin without a restricted user's turn).
function laterTurn(bridge, request, agent) {
  const attempt = bridge.assistants.ledger.attemptFor(request.id);
  const origin = bridge.teams?.store?.context?.(request.id);
  if (attempt?.state !== "completed" || attempt.reviewedAt) return false;
  if (origin?.kind === "member-result")
    return !!resultTurn(bridge.assistants, origin.requestId, attempt.id);
  return (
    ["owner", "telegram"].includes(origin?.kind) &&
    directOrigin(origin) &&
    !isUserAgent(agent)
  );
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
      // Only the plugin's mark of an event turn, never any other value.
      !(completion.internal === undefined || completion.internal === true) ||
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
      ...(completion.internal && { internal: true }),
    },
  };
}

/**
 * Why the Gateway's evidence does not prove that the run's completion reports only
 * processes the attempt's own run started; null when it does. OpenClaw reports
 * `id.slice(0, 8)`, so a reported id stands for every process with that exact
 * beginning, and all of them must be the turn's. `live` says that CompletionRuns
 * knows the run; otherwise only the plugin's mark of an event turn makes it one.
 */
export function processRefusal(evidence, attempt, runId, live = false) {
  if (!evidence) return "EVIDENCE";
  if (evidence.complete !== true) return "UNTRACKED";
  const completion = evidence.completion;
  if (!completion || completion.runId !== runId) return "NOT_COMPLETION";
  if (!live && completion.internal !== true) return "NOT_COMPLETION";
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

const execProvenance = { kind: "internal_system", sourceTool: "exec" };
const transcriptLimit = 200;
const entryText = (m) =>
  typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content) && m.content.length === 1 && m.content[0]?.type === "text"
      ? m.content[0].text
      : null;
/**
 * Whether a `sessions.get` page shows `runId` as an exec completion run: the entry
 * right before the run's first record is a user entry with exactly the exec
 * provenance (see transcriptHolds). Telegram delivery of a follow-up run's reply
 * needs no more (telegram-follow-ups.js): it grants nothing.
 */
export function completionRun(messages, runId) {
  if (!Array.isArray(messages) || typeof runId !== "string") return false;
  const first = messages.findIndex((m) => m?.__openclaw?.runId === runId);
  const entry = first > 0 ? messages[first - 1] : null;
  return (
    entry?.role === "user" &&
    (entry.__openclaw?.runId ?? runId) === runId &&
    isDeepStrictEqual(entry.provenance, execProvenance)
  );
}
export const completionTranscriptLimit = transcriptLimit;
/**
 * Whether a `sessions.get` page holds the user entry of the 2026.10.7 completion run
 * `runId` reporting `ids`. OpenClaw names that entry by neither its run nor its
 * idempotency key (`<random logical turn id>:user`): it is the entry right before
 * the run's first record (`__openclaw.runId`), which the run wrote before its tool
 * call. It must be a user entry with exactly the exec provenance whose content is
 * the completion's own process lines.
 */
export function transcriptHolds(messages, runId, ids) {
  if (!Array.isArray(messages)) return false;
  const first = messages.findIndex((m) => m?.__openclaw?.runId === runId);
  const entry = first > 0 ? messages[first - 1] : null;
  return (
    entry?.role === "user" &&
    (entry.__openclaw?.runId ?? runId) === runId &&
    isDeepStrictEqual(entry.provenance, execProvenance) &&
    isDeepStrictEqual(completedProcesses(entryText(entry)), ids)
  );
}

// The Gateway's transcript proves the event turn an exec completion; any failure
// refuses.
async function transcriptRefusal(bridge, input, completion) {
  try {
    const page = await bridge.assistants.runtime.client.call(
      "sessions.get",
      { key: input.sessionKey, limit: transcriptLimit },
      { timeoutMs: 5000 },
    );
    return transcriptHolds(page?.messages, input.runId, completion.ids)
      ? null
      : "NOT_COMPLETION";
  } catch {
    return "NOT_COMPLETION";
  }
}

// One read per run at a time: concurrent calls of a pending run wait for the same.
function verification(bridge, input, completion) {
  const reads = bridge.assistants.completionRuns?.verifying;
  const key = `${input.sessionKey}\u0000${input.runId}`;
  if (reads?.has(key)) return reads.get(key);
  const read = transcriptRefusal(bridge, input, completion).finally(() => {
    if (reads?.get(key) === read) reads.delete(key);
  });
  reads?.set(key, read);
  return read;
}

/**
 * The source of a call whose evidence proves it, or null (logged). A 2026.10.7 event
 * turn not yet verified is read from the transcript once (a promise), then admitted
 * to CompletionRuns and proven again; `verify: false` refuses it instead.
 */
function provenSource(bridge, input, { verify = true } = {}) {
  const source = continuationSource(bridge, input);
  if (!source) return null;
  const evidence = execEvidence(input.exec);
  const code = processRefusal(
    evidence,
    source.attempt,
    source.runId,
    !source.run.pending,
  );
  if (code) return refuse(bridge, input, code);
  if (!source.run.pending) return source;
  if (!verify) return refuse(bridge, input, "RUN");
  return verification(bridge, input, evidence.completion).then((refused) => {
    if (refused) return refuse(bridge, input, refused);
    bridge.assistants.completionRuns?.admit(source.runId, input.sessionKey);
    // The chat may have moved on during the read.
    return provenSource(bridge, input, { verify: false });
  });
}
const then = (value, next) => (value instanceof Promise ? value.then(next) : next(value));

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
  return then(provenSource(bridge, input), (source) => write(bridge, input, source));
}
function write(bridge, input, source) {
  if (!source) return false;
  audit(bridge.assistants, source, input);
  if (isShared(source.agent) && isMemory(input.path))
    // Its own note: the owner turn's own shared write keeps its key.
    bridge.noteShared(
      `${source.attempt.id}:${source.runId}:shared-write`,
      source.conversation.id,
    );
  return true;
}

/** A workspace or share ticket's binding for such a run, or null (TeamBridge.prepare). */
export function continuationBinding(bridge, input) {
  if (!continuationActions.has(input.action)) return null;
  return then(
    provenSource(bridge, input),
    (source) => source && { attemptId: source.attempt.id, runId: source.runId },
  );
}

/** Re-checks a continuation ticket on every step (TeamBridge.valid); throws. */
export function assertContinuation(bridge, record) {
  const source = provenSource(
    bridge,
    { ...record, runId: record.continuation.runId },
    { verify: false },
  );
  if (
    !continuationActions.has(record.action) ||
    source?.attempt.id !== record.continuation.attemptId
  )
    throw assistantProblem("invalid", 403);
  return record;
}
