// The live steps of an agent's running turn, from the Gateway's `agent` events
// (OpenClaw 2026.10.3; tests/integration/assistant-run-steps-contract.test.js):
// `item` frames of kind "tool" (phase start/update/end, `name`, `status`, a
// `meta` summary), `thinking` and `assistant` deltas, `run_status` phases
// (`retrying` with its attempt), `compaction` and `lifecycle` phases (an exec
// approval's `waiting-approval`). Only metadata leaves here:
// never command output, thinking or reply text, tool arguments or results. A
// command's label is OpenClaw's summary or the model's `title` for it, and only
// when it reads like a title, not like a command line or a secret.

/** At most this many steps per run go to the chat; older ones are counted. */
export const maxSteps = 24;
// Runs whose end never arrives are forgotten oldest first.
const maxRuns = 32;
const maxLabel = 80;
// Tools whose `meta` is the model's title or OpenClaw's summary of a command. Other
// tools describe themselves with their raw arguments (a URL, a path, a prompt).
const titled = new Set(["exec", "process"]);
// A label that looks like a secret, an assignment, a URL or a shell line is dropped.
const unsafe =
  /(?:token|secret|passw|bearer|api[_-]?key|private[_-]?key|credential|authorization)|[A-Za-z0-9_]+=\S|:\/\/|[|;&`$<>]|\b(?=[\w+/-]*\d)(?=[\w+/-]*[A-Za-z])[\w+/-]{20,}/i;

function label(data) {
  if (!titled.has(data.name) || typeof data.meta !== "string") return "";
  const text = data.meta.replace(/\s+/g, " ").trim();
  if (!text || unsafe.test(text)) return "";
  return text.slice(0, maxLabel);
}

const toolState = (data) =>
  data.phase !== "end"
    ? "running"
    : ["failed", "error", "blocked", "denied", "cancelled"].includes(data.status) ||
        data.isError === true
      ? "failed"
      : "done";

export class RunSteps {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.runs = new Map();
  }
  run(payload) {
    let run = this.runs.get(payload.runId);
    if (!run || run.sessionKey !== payload.sessionKey) {
      run = {
        sessionKey: payload.sessionKey,
        steps: [],
        omitted: 0,
        phase: "model",
        retry: null,
        at: this.now(),
      };
      this.runs.set(payload.runId, run);
      if (this.runs.size > maxRuns) this.runs.delete(this.runs.keys().next().value);
    }
    return run;
  }
  add(run, step) {
    run.steps.push(step);
    if (run.steps.length > maxSteps) {
      run.steps.shift();
      run.omitted++;
    }
  }
  /**
   * Takes one Gateway frame. Returns `{ runId, sessionKey, changed }` for a frame of
   * a run (any one is a sign of life), or null.
   */
  observe(frame) {
    const payload = frame?.payload;
    if (!["agent", "chat"].includes(frame?.event)) return null;
    if (typeof payload?.runId !== "string" || typeof payload.sessionKey !== "string")
      return null;
    const run = this.run(payload);
    run.at = this.now();
    const result = { runId: payload.runId, sessionKey: payload.sessionKey };
    if (frame.event === "chat") return { ...result, changed: false };
    const data = payload.data || {};
    const before = JSON.stringify([run.steps, run.phase, run.retry]);
    const last = run.steps.at(-1);
    switch (payload.stream) {
      case "item": {
        if (data.kind !== "tool" || typeof data.itemId !== "string") break;
        const tool = typeof data.name === "string" ? data.name.slice(0, 64) : "";
        const found = run.steps.find((s) => s.id === data.itemId);
        if (found) {
          found.state = toolState(data);
          found.label ||= label(data);
        } else
          this.add(run, {
            id: data.itemId.slice(0, 128),
            kind: "tool",
            tool,
            label: label(data),
            state: toolState(data),
          });
        run.retry = null;
        run.phase = run.steps.some((s) => s.kind === "tool" && s.state === "running")
          ? "tool"
          : "model";
        break;
      }
      case "thinking":
        if (last?.kind !== "thinking")
          this.add(run, {
            id: `thinking:${run.steps.length + run.omitted}`,
            kind: "thinking",
            state: "done",
          });
        run.retry = null;
        run.phase = "thinking";
        break;
      case "assistant":
        run.retry = null;
        run.phase = "writing";
        break;
      case "run_status":
        if (data.phase === "retrying") {
          const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
          run.retry = {
            attempt: count(data.retryAttempt),
            of: count(data.maxRetries),
            reason: typeof data.reason === "string" ? data.reason.slice(0, 32) : "",
          };
          run.phase = "retrying";
        } else if (data.phase === "starting_model" && run.phase !== "retrying")
          run.phase = "model";
        break;
      case "lifecycle":
        // An exec approval waits for a person, not for the model.
        if (data.phase === "waiting-approval") run.phase = "approval";
        else if (data.phase === "approval-resolved") run.phase = "tool";
        else if (["start", "model"].includes(data.phase) && run.phase !== "retrying")
          run.phase = "model";
        break;
      case "compaction":
        run.phase = data.phase === "start" ? "compacting" : "model";
        break;
      default:
        break;
    }
    return {
      ...result,
      changed: before !== JSON.stringify([run.steps, run.phase, run.retry]),
    };
  }
  /** What the chat shows of a run, or null: steps, phase and quiet time. */
  view(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      steps: run.steps.map((s) => ({ ...s })),
      omitted: run.omitted,
      phase: run.phase,
      retry: run.retry && { ...run.retry },
      quietMs: Math.max(0, this.now() - run.at),
    };
  }
  /** Every run as [runId, sessionKey, phase, quietMs], oldest first. */
  list() {
    const now = this.now();
    return [...this.runs].map(([id, r]) => [id, r.sessionKey, r.phase, now - r.at]);
  }
  /** The runs of one session, oldest first. */
  ofSession(sessionKey) {
    return [...this.runs]
      .filter(([, r]) => r.sessionKey === sessionKey)
      .map(([id]) => id);
  }
  end(runId) {
    this.runs.delete(runId);
  }
  clear() {
    this.runs.clear();
  }
}
