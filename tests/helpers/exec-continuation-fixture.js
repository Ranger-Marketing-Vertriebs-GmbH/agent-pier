import { randomUUID } from "node:crypto";
import { workflowFixture } from "./assistant-workflow-fixture.js";
import { nativeWriteGuard } from "./native-write-guard.js";
import { CompletionRuns } from "../../server/features/assistants/exec-continuation.js";

// OpenClaw 2026.10.3's completion prompt: one line per process with the first eight
// characters of its id (heartbeat-events-filter buildExecEventPrompt).
export const completionPrompt = (lines) =>
  "An async command you ran earlier has completed. The command completion details " +
  `are:\n\n${lines.join("\n")}\n\nTreat this completion as an internal continuation.`;

// OpenClaw 2026.10.7's completion turn: the bare line in the turn's timestamp envelope.
export const eventPrompt = (line) => `[Sat 2026-10-24 14:31 GMT+2] ${line}`;
const execProvenance = { kind: "internal_system", sourceTool: "exec" };
/**
 * A `sessions.get` page as OpenClaw 2026.10.7 writes it for an event turn: the
 * completion's user entry (exec provenance, a random logical turn id as its key, no
 * run id), then the run's own records.
 */
export function eventTranscript(runId, line, { entry = {} } = {}) {
  return [
    {
      role: "user",
      content: "Render it.",
      provenance: { kind: "external_user" },
      idempotencyKey: "owner-run:user",
      __openclaw: { idempotencyKey: "owner-run:user", seq: 1 },
    },
    { role: "assistant", content: [], __openclaw: { runId: "owner-run", seq: 2 } },
    {
      role: "user",
      content: line,
      provenance: execProvenance,
      idempotencyKey: "9a560d54-a41b-4bdc-a563-36106f676c5b:user",
      __openclaw: { senderIsOwner: false, seq: 3 },
      ...entry,
    },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-5", name: "write" }],
      __openclaw: { runId, seq: 4 },
    },
  ];
}

// What OpenClaw 2026.10.3's handleToolExecutionEnd sends as the hook's `error`: the
// first line of the result's message whenever isToolResultError holds for it (an
// error-like status, `error` or `timedOut` in its details, or a non-zero exit code).
export function openClawError(result) {
  const details = result?.details || {};
  const errorLike =
    /^(error|failed|failure|timeout|timed_out|blocked|denied)$/.test(
      String(details.status ?? ""),
    ) ||
    details.timedOut === true ||
    Boolean(details.error) ||
    (Number.isFinite(details.exitCode) && details.exitCode !== 0);
  const text = result?.content?.find?.((b) => b.type === "text")?.text;
  return errorLike && text ? text.trimStart().split(/\r?\n/, 1)[0].trim() : undefined;
}

/**
 * The fixture's agent with memory, the plugin's write guard live and the Gateway's
 * hooks driven as OpenClaw would: background exec results, a completion run's model
 * input and its heartbeat agent events.
 */
export async function execContinuationFixture(t, { userAccess, started = true } = {}) {
  const f = await workflowFixture(t);
  const body = {
    ...f.store.storedAssistant(f.id),
    capabilities: { memory: true, reminders: false },
    ...(userAccess ? { userAccess } : {}),
  };
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
  f.assistants.completionRuns = new CompletionRuns();
  const audits = [];
  f.assistants.audit = { append: (event) => audits.push(event) };
  f.services.audit = { append: (event) => audits.push(event) };
  const reads = [];
  // The Gateway's transcripts by session key (`sessions.get`); a function throws.
  const transcripts = new Map();
  f.assistants.runtime.client.call = async (method, params) => {
    reads.push({ method, params });
    if (method !== "sessions.get") return {};
    const page = transcripts.get(params.key);
    return typeof page === "function" ? page() : { messages: page || [] };
  };
  const guard = await nativeWriteGuard(t, f);
  if (started) await guard.emit("gateway_start", {}, {});
  let calls = 0;
  // An exec call of `runId` and its result: backgrounded ("running") or not.
  const exec = async (
    runId,
    {
      sessionId = "brisk-orbit",
      status = "running",
      sessionKey = "session",
      pid,
      result,
      error,
    } = {},
  ) => {
    const ctx = { agentId: guard.agentId, sessionKey, runId, toolCallId: `x${++calls}` };
    const outcome = result ?? {
      content: [{ type: "text", text: `Command ${status}.\nDetails follow.` }],
      details: { status, sessionId, pid },
    };
    const failure = error ?? openClawError(outcome);
    await guard.emit("before_tool_call", { toolName: "exec", params: {} }, ctx);
    await guard.emit(
      "after_tool_call",
      {
        toolName: "exec",
        params: {},
        result: outcome,
        ...(failure ? { error: failure } : {}),
      },
      ctx,
    );
  };
  // A turn of this origin that ran an exec (or not) and ended.
  const turn = async (origin, { exec: runs = true, ...options } = {}) => {
    const { attemptId } = await f.invocation(randomUUID(), origin);
    if (runs) await exec(attemptId, options);
    f.assistants.ledger.transition(attemptId, "completed");
    return attemptId;
  };
  // OpenClaw's completion run: its heartbeat agent events and its model input.
  const wake = async (
    runId = "wake-1",
    {
      lines = ["Exec completed (brisk-or, code 1) :: done"],
      prompt = completionPrompt(lines),
      sessionKey = "session",
      event = {},
    } = {},
  ) => {
    f.assistants.completionRuns.observe({
      runId,
      sessionKey,
      stream: "lifecycle",
      isHeartbeat: true,
      data: { phase: "start" },
      ...event,
    });
    await guard.emit("llm_input", { runId, prompt }, { sessionKey, runId });
    return { agentId: guard.agentId, sessionKey: "session", runId };
  };
  // OpenClaw 2026.10.7's completion run: an ordinary event turn whose agent events
  // carry no mark, its model input with the hooks' `trigger` and its transcript.
  const eventTurn = async (
    runId = "turn-1",
    {
      line = "Exec completed (brisk-or, code 1) :: done",
      prompt = eventPrompt(line),
      trigger = "event",
      sessionKey = "session",
      transcript = eventTranscript(runId, line),
    } = {},
  ) => {
    f.assistants.completionRuns.observe({
      runId,
      sessionKey,
      stream: "lifecycle",
      isHeartbeat: false,
      data: { phase: "start" },
    });
    await guard.emit("llm_input", { runId, prompt }, { sessionKey, runId, trigger });
    transcripts.set(sessionKey, transcript);
    return { agentId: guard.agentId, sessionKey, runId };
  };
  const writes = () =>
    audits
      .filter((e) => e.details?.via === "exec-completion")
      .map((e) => [e.details.filePath, e.details.sourceAttemptId]);
  return {
    ...f,
    ...guard,
    audits,
    reads,
    transcripts,
    exec,
    turn,
    wake,
    eventTurn,
    writes,
  };
}
