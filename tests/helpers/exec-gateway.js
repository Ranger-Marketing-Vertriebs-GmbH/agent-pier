import { openClawError } from "./agent-run-fixture.js";
import {
  execBounds,
  execEvidence,
  registerExecProcesses,
} from "../../server/features/assistants/team-plugin/exec-processes.js";

// The team plugin's record of background commands (team-plugin/exec-processes.js)
// with its Gateway hooks driven as OpenClaw would.
export const prompt = (ids) =>
  "An async command you ran earlier has completed. The command completion details " +
  `are:\n\n${ids.map((id) => `Exec completed (${id}, code 0) :: ok`).join("\n")}` +
  "\n\nTreat this completion as an internal continuation.";

export function gateway(t, { started = true, bounds = {} } = {}) {
  delete globalThis[Symbol.for("agentpier.execProcesses")];
  const saved = { ...execBounds };
  Object.assign(execBounds, bounds);
  t.after(() => {
    Object.assign(execBounds, saved);
    delete globalThis[Symbol.for("agentpier.execProcesses")];
  });
  const hooks = [];
  registerExecProcesses({ on: (name, handler) => hooks.push({ name, handler }) });
  const emit = (name, event, ctx) =>
    hooks.filter((h) => h.name === name).forEach((h) => h.handler(event, ctx));
  if (started) emit("gateway_start", {}, {});
  let n = 0;
  // As OpenClaw 2026.10.3 sends it: `error` for every error-like result.
  const exec = (
    sessionKey,
    runId,
    result,
    error = openClawError(result),
    params = {},
  ) => {
    const ctx = { sessionKey, runId, toolCallId: `c${++n}` };
    emit("before_tool_call", { toolName: "exec", params }, ctx);
    emit("after_tool_call", { toolName: "exec", result, ...(error && { error }) }, ctx);
  };
  const background = (sessionKey, runId, id, params) =>
    exec(
      sessionKey,
      runId,
      { details: { status: "running", sessionId: id, pid: 1 } },
      undefined,
      params,
    );
  const complete = (sessionKey, runId, ids) =>
    emit("llm_input", { runId, prompt: prompt(ids) }, { sessionKey, runId });
  const proof = (sessionKey, runId) => execEvidence(sessionKey, runId);
  return { emit, exec, background, complete, proof };
}
