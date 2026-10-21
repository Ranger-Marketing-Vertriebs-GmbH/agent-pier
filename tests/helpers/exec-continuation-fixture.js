import { randomUUID } from "node:crypto";
import { workflowFixture } from "./assistant-workflow-fixture.js";
import { nativeWriteGuard } from "./native-write-guard.js";
import { HeartbeatRuns } from "../../server/features/assistants/exec-continuation.js";

// OpenClaw 2026.10.3's completion prompt: one line per process with the first eight
// characters of its id (heartbeat-events-filter buildExecEventPrompt).
export const completionPrompt = (lines) =>
  "An async command you ran earlier has completed. The command completion details " +
  `are:\n\n${lines.join("\n")}\n\nTreat this completion as an internal continuation.`;

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
  f.assistants.heartbeatRuns = new HeartbeatRuns();
  const audits = [];
  f.assistants.audit = { append: (event) => audits.push(event) };
  f.services.audit = { append: (event) => audits.push(event) };
  const reads = [];
  f.assistants.runtime.client.call = async (method, params) => {
    reads.push({ method, params });
    return {};
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
    await guard.emit("before_tool_call", { toolName: "exec", params: {} }, ctx);
    await guard.emit(
      "after_tool_call",
      {
        toolName: "exec",
        params: {},
        result: result === undefined ? { details: { status, sessionId, pid } } : result,
        ...(error ? { error } : {}),
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
    f.assistants.heartbeatRuns.observe({
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
  const writes = () =>
    audits
      .filter((e) => e.details?.via === "exec-completion")
      .map((e) => [e.details.filePath, e.details.sourceAttemptId]);
  return { ...f, ...guard, audits, reads, exec, turn, wake, writes };
}
