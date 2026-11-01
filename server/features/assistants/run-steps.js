// The live steps of an agent's running turn, from the normalized `step` of the
// runtime port's run events (runtimes/agent-runtime.js events.subscribe): tool calls
// (start, update, end, failed), thinking, writing, status phases (`retrying` with
// its attempt, `starting_model`), lifecycle phases (an exec approval's
// `waiting-approval`) and compaction. Only metadata leaves here: never command
// output, thinking or reply text, tool arguments or results. A tool's label is the
// runtime's `title` for it, and only when it reads like a title, not like a command
// line or a secret.

/** At most this many steps per run go to the chat; older ones are counted. */
export const maxSteps = 24;
// Runs whose end never arrives are forgotten oldest first.
const maxRuns = 32;
const maxLabel = 80;
// The kinds of run events that belong to a run (RUN_EVENT_KINDS without approvals).
const runKinds = new Set([
  "started",
  "text",
  "tool",
  "progress",
  "finished",
  "aborted",
  "failed",
]);
// A label that looks like a secret, an assignment, a URL or a shell line is dropped.
const unsafe =
  /(?:token|secret|passw|bearer|api[_-]?key|private[_-]?key|credential|authorization)|[A-Za-z0-9_]+=\S|:\/\/|[|;&`$<>]|\b(?=[\w+/-]*\d)(?=[\w+/-]*[A-Za-z])[\w+/-]{20,}/i;

function label(step) {
  if (typeof step.title !== "string") return "";
  const text = step.title.replace(/\s+/g, " ").trim();
  if (!text || unsafe.test(text)) return "";
  return text.slice(0, maxLabel);
}

const toolState = (step) =>
  step.phase !== "end" ? "running" : step.failed === true ? "failed" : "done";

export class RunSteps {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.runs = new Map();
  }
  run(event) {
    let run = this.runs.get(event.runId);
    if (!run || run.sessionKey !== event.sessionKey) {
      run = {
        sessionKey: event.sessionKey,
        steps: [],
        omitted: 0,
        phase: "model",
        retry: null,
        at: this.now(),
        live: true,
      };
      this.runs.set(event.runId, run);
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
   * Takes one run event: its `kind`, `runId`, `sessionKey` and `step`. Returns
   * `{ runId, sessionKey, changed }` for an event of a run (any one is a sign of
   * life), or null.
   */
  observe(event) {
    if (!runKinds.has(event?.kind)) return null;
    if (typeof event.runId !== "string" || typeof event.sessionKey !== "string")
      return null;
    const run = this.run(event);
    run.at = this.now();
    run.live = true;
    const result = { runId: event.runId, sessionKey: event.sessionKey };
    const step = event.step;
    if (!step || typeof step !== "object") return { ...result, changed: false };
    const before = JSON.stringify([run.steps, run.phase, run.retry]);
    const last = run.steps.at(-1);
    switch (step.type) {
      case "tool": {
        if (typeof step.id !== "string") break;
        const tool = typeof step.name === "string" ? step.name.slice(0, 64) : "";
        // Stored and matched alike, so a long id still finds its step.
        const id = step.id.slice(0, 128);
        const found = run.steps.find((s) => s.id === id);
        if (found) {
          found.state = toolState(step);
          found.label ||= label(step);
        } else
          this.add(run, {
            id,
            kind: "tool",
            tool,
            label: label(step),
            state: toolState(step),
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
      case "writing":
        run.retry = null;
        run.phase = "writing";
        break;
      case "status":
        if (step.phase === "retrying") {
          const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
          run.retry = {
            attempt: count(step.attempt),
            of: count(step.of),
            reason: typeof step.reason === "string" ? step.reason.slice(0, 32) : "",
          };
          run.phase = "retrying";
        } else if (step.phase === "starting_model" && run.phase !== "retrying")
          run.phase = "model";
        break;
      case "lifecycle":
        // An exec approval waits for a person, not for the model.
        if (step.phase === "waiting-approval") run.phase = "approval";
        else if (step.phase === "approval-resolved") run.phase = "tool";
        else if (["start", "model"].includes(step.phase) && run.phase !== "retrying")
          run.phase = "model";
        break;
      case "compaction":
        run.phase = step.phase === "start" ? "compacting" : "model";
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
  /**
   * A run's state now, or null: its session, phase, quiet time and whether a frame
   * of it arrived since the Gateway last reconnected.
   */
  state(runId) {
    const run = this.runs.get(runId);
    if (!run) return null;
    const { sessionKey, phase, live } = run;
    return { sessionKey, phase, live, quietMs: Math.max(0, this.now() - run.at) };
  }
  /**
   * The Gateway reconnected: frames may have been lost, a run's end among them. Its
   * steps stay for the chat, but its quiet time proves nothing until it sends again.
   */
  reconnected() {
    for (const run of this.runs.values()) run.live = false;
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
