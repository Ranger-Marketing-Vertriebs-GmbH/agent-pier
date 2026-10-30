import { randomUUID } from "node:crypto";
import { workflowFixture } from "./assistant-workflow-fixture.js";
import { nativeWriteGuard } from "./native-write-guard.js";
import { CompletionRuns } from "../../server/features/assistants/completion-runs.js";

// OpenClaw 2026.10.3's completion prompt: one line per process with the first eight
// characters of its id (heartbeat-events-filter buildExecEventPrompt).
export const completionPrompt = (lines) =>
  "An async command you ran earlier has completed. The command completion details " +
  `are:\n\n${lines.join("\n")}\n\nTreat this completion as an internal continuation.`;

// OpenClaw 2026.10.7's completion turn: the bare line in the turn's timestamp envelope.
export const eventPrompt = (line) => `[Sat 2026-10-24 14:31 GMT+2] ${line}`;

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
 * hooks driven as OpenClaw would: turns that ran an exec and ended, and OpenClaw's
 * own runs of the chat without a turn (owner-runs.js), as a command's follow-up.
 */
export async function agentRunFixture(t, { userAccess, started = true } = {}) {
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
      result,
      error,
    } = {},
  ) => {
    const ctx = { agentId: guard.agentId, sessionKey, runId, toolCallId: `x${++calls}` };
    const outcome = result ?? {
      content: [{ type: "text", text: `Command ${status}.\nDetails follow.` }],
      details: { status, sessionId },
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
  // OpenClaw 2026.10.7's follow-up after a background command: an event turn of the
  // chat's session without an AgentPier attempt.
  const eventTurn = async (
    runId = "turn-1",
    {
      line = "Exec completed (brisk-or, code 1) :: done",
      prompt = eventPrompt(line),
      sessionKey = "session",
    } = {},
  ) => {
    await guard.emit(
      "llm_input",
      { runId, prompt },
      { sessionKey, runId, trigger: "event" },
    );
    return { agentId: guard.agentId, sessionKey, runId };
  };
  // Native writes of runs without a turn, as audited (owner-runs.js).
  const writes = () =>
    audits.filter((e) => e.details?.via === "agent-run").map((e) => e.details.filePath);
  return { ...f, ...guard, audits, exec, turn, eventTurn, writes };
}
