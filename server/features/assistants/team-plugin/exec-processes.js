// What the Gateway itself knows about the background commands of each session, for
// AgentPier's proof that an exec completion run continues an owner turn
// (exec-continuation.js). OpenClaw 2026.10.3 names a process by an adjective-noun
// slug that is unique only among live processes, and tells the completion run only
// its first eight characters (`Exec <status> (<id>, <exit>)`). So AgentPier needs
// every background process of the session with its full id and the run that
// started it. Only the Gateway's own hooks see them all, without reading the
// transcript:
// - after_tool_call of `exec`: a result with `status: "running"` is a backgrounded
//   process (`details.sessionId`), started by `ctx.runId`;
// - llm_input (conversation access, runtime-config.js): the prompt of a completion
//   run starts with OpenClaw's completion text and lists its processes;
// - gateway_start: the record is complete only when it existed before the Gateway
//   started serving, so no earlier process can be missing.
// Anything unclear marks the session uncertain for the rest of the Gateway's life,
// and AgentPier then refuses: an exec result that is neither running nor a known
// end (an approval that may still start a command, an unknown shape), or an exec
// call whose run ended without a result. The record lives on globalThis, so a
// plugin reload in the same Gateway process keeps it.
const store = Symbol.for("agentpier.execProcesses");
const maxProcesses = 4096,
  maxSessions = 4096,
  maxCompletions = 256,
  maxCalls = 1024;
// Exec results that never leave a process running for a later completion.
const ended = new Set([
  "completed",
  "failed",
  "denied",
  "spawn-failed",
  "run-aborted",
  "approval-unavailable",
  "approval-state-write-failed",
  "missing-run-id",
  "operand-drift",
]);

export function execRecord() {
  return (globalThis[store] ??= {
    complete: false,
    sessions: new Map(),
    completions: new Map(),
    calls: new Map(),
    pending: new Map(),
  });
}

function session(record, key) {
  let entry = record.sessions.get(key);
  if (!entry) {
    // Forgetting a session would hide its processes: past the bound nothing is
    // complete any more.
    if (record.sessions.size >= maxSessions) record.complete = false;
    entry = { processes: [], uncertain: false };
    record.sessions.set(key, entry);
  }
  return entry;
}
const bounded = (map, max, key, value) => {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
};

// OpenClaw's completion prompt (heartbeat-events-filter buildExecEventPrompt): one
// line per process, `Exec <status> (<first 8 characters of its id>, <exit>)`, then
// ` :: <output>` folded to one line, or ` without captured stdout/stderr.`.
const detailsStart =
  "An async command you ran earlier has completed. The command completion details are:\n\n";
const detailsEnd = "\n\nTreat this completion";
const processLine =
  /^Exec [a-z]+ \(([A-Za-z0-9_-]{1,8}), [^)\n]*\)(?: :: .*| without captured stdout\/stderr\.)?$/;
/**
 * The process ids a completion prompt reports, or null when they cannot all be read:
 * another prompt (no output, delivery off), a truncated list or any line that is not
 * a process line (an approval's `Exec finished (gateway id=…)` with raw output).
 */
export function completedProcesses(text) {
  if (typeof text !== "string") return null;
  // Only a prompt that is the completion itself, never text quoting one.
  if (!text.startsWith(detailsStart)) return null;
  const end = text.indexOf(detailsEnd, detailsStart.length);
  if (end < 0) return null;
  const lines = text
    .slice(detailsStart.length, end)
    .split("\n")
    .filter((line) => line.trim());
  const ids = lines.map((line) => processLine.exec(line)?.[1]);
  return ids.length && ids.every(Boolean) ? ids : null;
}

/**
 * What AgentPier's proof reads for a call of `runId` in `sessionKey`: whether the
 * record is complete, the run's completion and every background process of the
 * session that the completion's ids could stand for (the same first characters
 * OpenClaw reports), whichever run started it.
 */
export function execEvidence(sessionKey, runId) {
  const record = execRecord();
  const entry = record.sessions.get(sessionKey);
  const found = typeof runId === "string" && record.completions.get(runId);
  const completion = found && found.sessionKey === sessionKey ? found : null;
  const pending = [...record.pending.values()].some((p) => p.sessionKey === sessionKey);
  const ids = new Set(completion?.ids || []);
  const processes = (entry?.processes || []).filter((p) => ids.has(p.id.slice(0, 8)));
  // More than one message carries is never cut short: the record then proves nothing.
  const fits = processes.length <= 256;
  return {
    complete: record.complete === true && !entry?.uncertain && !pending && fits,
    processes: fits ? processes.map(({ id, runId: by }) => ({ id, runId: by })) : [],
    completion: completion && { runId, ids: completion.ids, at: completion.at },
  };
}

/** The run of a plugin tool call (its execute context names no run). */
export const callRun = (toolCallId) => execRecord().calls.get(toolCallId) ?? null;

export function registerExecProcesses(api) {
  const record = execRecord();
  // The first registration in a Gateway process precedes its start; a record that
  // only appears later may have missed processes and never becomes complete.
  api.on("gateway_start", () => {
    if (!record.started) record.complete = record.sessions.size === 0;
    record.started = true;
  });
  api.on(
    "before_tool_call",
    (event, ctx) => {
      if (typeof ctx?.toolCallId === "string" && typeof ctx.runId === "string")
        bounded(record.calls, maxCalls, ctx.toolCallId, ctx.runId);
      if (event?.toolName === "exec" && typeof ctx?.sessionKey === "string")
        record.pending.set(ctx.toolCallId ?? Symbol(), {
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
        });
      return undefined;
    },
    { priority: 1100 },
  );
  api.on("after_tool_call", (event, ctx) => {
    if (event?.toolName !== "exec" || typeof ctx?.sessionKey !== "string") return;
    record.pending.delete(ctx.toolCallId);
    const entry = session(record, ctx.sessionKey);
    // A call that threw started nothing it reports.
    if (event.error && event.result === undefined) return;
    const details = event.result?.details;
    const runId = ctx.runId ?? event.runId;
    if (
      details?.status === "running" &&
      typeof details.sessionId === "string" &&
      typeof runId === "string"
    ) {
      if (entry.processes.length >= maxProcesses) entry.uncertain = true;
      else entry.processes.push({ id: details.sessionId, runId, at: Date.now() });
    } else if (!ended.has(details?.status)) entry.uncertain = true;
  });
  api.on("agent_end", (_event, ctx) => {
    // An exec call of this run that never reported its result.
    for (const [key, call] of record.pending)
      if (call.runId === ctx?.runId) {
        record.pending.delete(key);
        session(record, call.sessionKey).uncertain = true;
      }
  });
  // Conversation access (runtime-config.js): the model input of every run.
  api.on("llm_input", (event, ctx) => {
    const runId = event?.runId ?? ctx?.runId;
    if (typeof runId !== "string" || typeof ctx?.sessionKey !== "string") return;
    if (record.completions.has(runId)) return;
    const ids = completedProcesses(event?.prompt);
    bounded(record.completions, maxCompletions, runId, {
      sessionKey: ctx.sessionKey,
      ids,
      at: Date.now(),
    });
  });
}
