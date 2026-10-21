// What the Gateway itself knows about the background commands of each session, for
// AgentPier's proof that an exec completion run continues an owner turn
// (exec-continuation.js). OpenClaw 2026.10.3 names a process by an adjective-noun
// slug that is unique only among live processes, and tells the completion run only
// its first eight characters (`Exec <status> (<id>, <exit>)`). So AgentPier needs
// every background process of the session with its full id and the run that
// started it. Only the Gateway's own hooks see them all, without reading the
// transcript:
// - after_tool_call of `exec`: a result with `status: "running"` is a backgrounded
//   process (`details.sessionId`), started by `ctx.runId`, with the call's
//   `timeoutSeconds`. OpenClaw
//   keeps its own "not started" mark (markToolExecutionNotStarted) private, so an
//   errored call counts as having started nothing only when its error is one that
//   OpenClaw raises before the command can start (`notStarted`, verbatim from
//   2026.10.3): argument validation, or the exec host checks marked not started.
//   Every other error leaves its session uncertain: OpenClaw may report an error
//   after the command already ran in the background (an abort after the yield);
// - llm_input (conversation access, runtime-config.js): the prompt of a completion
//   run starts with OpenClaw's completion text and lists its processes;
// - gateway_start: the record is complete only when it existed before the Gateway
//   started serving, so no earlier process can be missing.
// A process leaves the record only when its end is positively observed, never by
// its pid: OpenClaw's exec session (and its completion) lasts until the command's
// output closes, so a shell that exits while `cmd &` runs on is still live.
// - a completion run lists it, and it is the session's only recorded process with
//   that prefix (several sharing one stay: which one ended is unknown);
// - the process tool reports it finished (`status` completed or failed with its
//   `sessionId`);
// - its own hard bound passed: the call's `timeoutSeconds` above zero, plus
//   `marginMs`; its prefix then stays refused for another `dropAfterMs`
//   (`dropped`), in case its completion is still on its way.
// An ended process leaves the record `dropAfterMs` after its end, past any window
// its completion run can still prove in. A process without a known end or bound
// stays (with timeout 0 or none, a silent success that is never polled): its
// prefix keeps refusing other runs' completions in that session.
// Every bound keeps memory small and fails closed for one session only:
// - a session with more live processes than `maxProcesses` is uncertain;
// - past `maxSessions` the least recently used session is forgotten, and its key is
//   remembered in a bit filter: that session, and the rare one sharing its bits,
//   stays uncertain for the Gateway's life, every other session is unaffected;
// - an exec result that is neither running nor a known end (an approval that may
//   still start a command, an unknown shape), or an exec call whose run ended
//   without a result, marks its session uncertain.
// The record lives on globalThis, so a plugin reload in the same Gateway process
// keeps it.
const store = Symbol.for("agentpier.execProcesses");
export const execBounds = {
  maxProcesses: 4096,
  maxSessions: 4096,
  maxCompletions: 256,
  maxCalls: 1024,
  maxPending: 1024,
  dropAfterMs: 2 * 3600000,
  marginMs: 10 * 60000,
};
const filterBits = 1 << 20;
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
  "skipped",
  // A before_tool_call block (buildBlockedToolResult) before anything ran.
  "blocked",
]);
// Errors OpenClaw 2026.10.3 raises before an exec command can start: argument
// validation (validation.js validateToolArguments) and resolveExecTarget, whose
// errors are marked not started.
const notStarted = [
  /^Validation failed for tool "exec":\n/,
  /^This session requires a sandbox, but its sandbox runtime is unavailable\.$/,
  /^Elevated execution is unavailable because this session requires a sandbox\.$/,
  /^exec host not allowed \(requested [a-z]+; this session requires a sandbox\)\.$/,
  /^exec host not allowed \(requested [a-z]+; configured host is [a-z]+; set tools\.exec\.host=[a-z]+(?: or [a-z]+)* to allow this override\)\.$/,
];
// An errored call's whole message (the hook's `error` is only its first line).
function startedNothing(event) {
  if (typeof event.error !== "string") return false;
  const content = event.result?.content;
  const text =
    Array.isArray(content) && content.length === 1 && content[0]?.type === "text"
      ? content[0].text
      : event.error;
  return typeof text === "string" && notStarted.some((p) => p.test(text.trim()));
}

export function execRecord() {
  return (globalThis[store] ??= {
    complete: false,
    sessions: new Map(),
    completions: new Map(),
    calls: new Map(),
    pending: new Map(),
    forgotten: new Uint32Array(filterBits / 32),
  });
}

// The forgotten sessions' filter: three FNV-1a hashes of the key.
function bits(key) {
  const out = [];
  for (let seed = 0; seed < 3; seed += 1) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < key.length; i += 1)
      h = Math.imul(h ^ key.charCodeAt(i), 0x01000193) >>> 0;
    out.push(h % filterBits);
  }
  return out;
}
const forget = (record, key) => {
  for (const b of bits(key)) record.forgotten[b >>> 5] |= 1 << (b & 31);
};
const forgotten = (record, key) =>
  bits(key).every((b) => record.forgotten[b >>> 5] & (1 << (b & 31)));

// The entry of a session, most recently used last; created only when needed.
function session(record, key, create = true) {
  let entry = record.sessions.get(key);
  if (entry) record.sessions.delete(key);
  else if (create) {
    // A session forgotten before may have had processes this entry never saw.
    entry = { processes: [], dropped: [], uncertain: forgotten(record, key) };
    // Entries with nothing left go first; only then is a live one forgotten.
    if (record.sessions.size >= execBounds.maxSessions)
      for (const [k, e] of record.sessions) tidy(record, k, e);
    if (record.sessions.size >= execBounds.maxSessions) {
      // The least recently used one without a recorded process, else the oldest.
      const idle = [...record.sessions].find(([, e]) => !e.processes.length);
      const oldest = idle ? idle[0] : record.sessions.keys().next().value;
      record.sessions.delete(oldest);
      forget(record, oldest);
    }
  } else return null;
  record.sessions.set(key, entry);
  return entry;
}
const bounded = (map, max, key, value) => {
  map.set(key, value);
  if (map.size > max) map.delete(map.keys().next().value);
};
// Removes processes whose end, or bound, lies long enough behind.
// A removed process stays a candidate under its prefix (`dropped`, with the run
// that started it) for one more window, so a completion still on its way is judged
// against it like before.
function prune(entry, now = Date.now()) {
  entry.dropped = entry.dropped.filter((d) => now - d.at < execBounds.dropAfterMs);
  entry.processes = entry.processes.filter((p) => {
    const gone = p.endedAt
      ? now - p.endedAt >= execBounds.dropAfterMs
      : p.timeoutSec > 0 && now - p.at > p.timeoutSec * 1000 + execBounds.marginMs;
    if (gone) entry.dropped.push({ prefix: p.id.slice(0, 8), runId: p.runId, at: now });
    return !gone;
  });
  const excess = entry.processes.length - execBounds.maxProcesses;
  if (excess > 0) {
    entry.uncertain = true;
    entry.processes.splice(0, excess);
  }
}
// An entry with nothing left to remember goes, so it never pushes a live session
// out of the bound (an uncertain one stays).
function tidy(record, key, entry) {
  prune(entry);
  if (!entry.processes.length && !entry.dropped.length && !entry.uncertain)
    record.sessions.delete(key);
}
// Only when the report can mean that one process: every recorded process it could
// name counts, ended ones included (an ended process's completion may still be
// delivered after the process tool showed its end).
function ending(entry, prefix, now = Date.now()) {
  const found = entry.processes.filter((p) => p.id.slice(0, 8) === prefix);
  if (entry.dropped.some((d) => d.prefix === prefix)) return;
  if (found.length === 1 && !found[0].endedAt) found[0].endedAt = now;
}
// The process tool names a process by its whole id: that one process ended, whatever
// shares its prefix. It stays a candidate like any ended process.
function endingById(entry, id, now = Date.now()) {
  const found = entry.processes.filter((p) => p.id === id);
  if (found.length === 1 && !found[0].endedAt) found[0].endedAt = now;
}

// OpenClaw's completion prompt (heartbeat-events-filter buildExecEventPrompt): one
// line per process, `Exec <status> (<first 8 characters of its id>, <exit>)`, then
// ` :: <output>` folded to one line, or ` without captured stdout/stderr.`.
const detailsStart =
  "An async command you ran earlier has completed. The command completion details are:\n\n";
const detailsEnd = "\n\nTreat this completion";
const processLine =
  /^Exec [a-z]+ \(([A-Za-z0-9_-]{1,8}), [^)\n]*\)(?: :: .*| without captured stdout\/stderr\.)?$/;
// OpenClaw's fixed note after a process line when the command hit its timeout
// (user-facing-text EXEC_TIMEOUT_RETRY_GUIDANCE), accepted verbatim and only there.
const timeoutGuidance =
  "The command was terminated, but external side effects may already have completed. Verify the resulting state before retrying. Do not automatically rerun non-idempotent commands. Use a higher timeout only when the command is known to be safe to retry.";
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
  const ids = [];
  // The guidance follows the process line it belongs to, once.
  let noted = 0;
  for (const line of lines) {
    const id = processLine.exec(line)?.[1];
    if (id) ids.push(id);
    else if (line === timeoutGuidance && ids.length > noted) noted = ids.length;
    else return null;
  }
  return ids.length ? ids : null;
}

/**
 * What AgentPier's proof reads for a call of `runId` in `sessionKey`: whether the
 * session's record is complete, the run's completion and every background process
 * of the session that the completion's ids could stand for (the same first
 * characters OpenClaw reports), whichever run started it.
 */
export function execEvidence(sessionKey, runId) {
  const record = execRecord();
  const entry = session(record, sessionKey, false);
  if (entry) tidy(record, sessionKey, entry);
  const found = typeof runId === "string" && record.completions.get(runId);
  const completion = found && found.sessionKey === sessionKey ? found : null;
  const pending = [...record.pending.values()].some((p) => p.sessionKey === sessionKey);
  const ids = new Set(completion?.ids || []);
  // Every process the ids could stand for: recorded ones and those just removed.
  const processes = [
    ...(entry?.processes || []).filter((p) => ids.has(p.id.slice(0, 8))),
    ...(entry?.dropped || [])
      .filter((d) => ids.has(d.prefix))
      .map((d) => ({ id: d.prefix, runId: d.runId })),
  ];
  // More than one message carries is never cut short: the record then proves nothing.
  const complete =
    record.complete === true &&
    !(entry ? entry.uncertain : forgotten(record, sessionKey)) &&
    !pending &&
    processes.length <= 256;
  return {
    complete,
    processes: complete ? processes.map(({ id, runId: by }) => ({ id, runId: by })) : [],
    completion: completion && { runId, ids: completion.ids, at: completion.at },
  };
}

/** The run of a plugin tool call (its execute context names no run). */
export const callRun = (sessionKey, toolCallId) =>
  execRecord().calls.get(`${sessionKey}\u0000${toolCallId}`) ?? null;

// An open exec call: its session, run and tool call (an id alone may repeat).
const callKey = (ctx) =>
  typeof ctx.toolCallId === "string"
    ? `${ctx.sessionKey}\u0000${ctx.runId ?? ""}\u0000${ctx.toolCallId}`
    : Symbol("exec call");

/** Records an exec result (after_tool_call); exported for the tests' fixture. */
export function recordExec(record, event, ctx) {
  const key = ctx.sessionKey;
  const call = record.pending.get(callKey(ctx));
  record.pending.delete(callKey(ctx));
  const details = event.result?.details;
  const runId = ctx.runId ?? event.runId;
  if (
    details?.status === "running" &&
    typeof details.sessionId === "string" &&
    typeof runId === "string"
  ) {
    const entry = session(record, key);
    const timeout = call?.timeoutSec ?? event.params?.timeoutSeconds;
    entry.processes.push({
      id: details.sessionId,
      runId,
      at: Date.now(),
      timeoutSec: Number.isFinite(timeout) && timeout > 0 ? timeout : 0,
    });
    prune(entry);
    return;
  }
  // A known end left nothing running: the command ran in the foreground and is over,
  // or never ran (OpenClaw also sets the hook's `error` for a failed or denied one).
  // Otherwise only a call OpenClaw refused before it could start.
  if (ended.has(details?.status) || startedNothing(event)) return;
  session(record, key).uncertain = true;
}

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
      if (
        typeof ctx?.toolCallId === "string" &&
        typeof ctx.runId === "string" &&
        typeof ctx.sessionKey === "string"
      )
        bounded(
          record.calls,
          execBounds.maxCalls,
          `${ctx.sessionKey}\u0000${ctx.toolCallId}`,
          ctx.runId,
        );
      return undefined;
    },
    { priority: 1100 },
  );
  // An exec call that goes ahead: registered last, after every hook that may block
  // it (OpenClaw stops at the first block). A later block still reports its result.
  api.on(
    "before_tool_call",
    (event, ctx) => {
      if (event?.toolName === "exec" && typeof ctx?.sessionKey === "string") {
        record.pending.set(callKey(ctx), {
          sessionKey: ctx.sessionKey,
          runId: ctx.runId,
          timeoutSec: event.params?.timeoutSeconds,
        });
        // A call forgotten past the bound is as unknown as one that never reported.
        if (record.pending.size > execBounds.maxPending) {
          const [oldest, call] = record.pending.entries().next().value;
          record.pending.delete(oldest);
          session(record, call.sessionKey).uncertain = true;
        }
      }
      return undefined;
    },
    { priority: -1_000_000 },
  );
  api.on("after_tool_call", (event, ctx) => {
    if (typeof ctx?.sessionKey !== "string") return;
    if (event?.toolName === "exec") recordExec(record, event, ctx);
    // The process tool reports a finished process with its session id.
    const details = event?.result?.details;
    if (
      event?.toolName === "process" &&
      ["completed", "failed"].includes(details?.status) &&
      typeof details.sessionId === "string"
    ) {
      const entry = session(record, ctx.sessionKey, false);
      if (entry) endingById(entry, details.sessionId);
    }
  });
  api.on("agent_end", (_event, ctx) => {
    // An exec call of this run that never reported its result.
    for (const [key, call] of record.pending)
      if (call.runId === ctx?.runId) {
        record.pending.delete(key);
        session(record, call.sessionKey).uncertain = true;
      }
    // A completion is read only while its run lasts.
    if (typeof ctx?.runId === "string") record.completions.delete(ctx.runId);
  });
  // Conversation access (runtime-config.js): the model input of a completion run.
  api.on("llm_input", (event, ctx) => {
    const runId = event?.runId ?? ctx?.runId;
    if (typeof runId !== "string" || typeof ctx?.sessionKey !== "string") return;
    if (record.completions.has(runId)) return;
    const ids = completedProcesses(event?.prompt);
    if (!ids) return;
    // The completion's processes have ended: each that one prefix names alone.
    const entry = session(record, ctx.sessionKey, false);
    if (entry) for (const id of ids) ending(entry, id);
    bounded(record.completions, execBounds.maxCompletions, runId, {
      sessionKey: ctx.sessionKey,
      ids,
      at: Date.now(),
    });
  });
}
