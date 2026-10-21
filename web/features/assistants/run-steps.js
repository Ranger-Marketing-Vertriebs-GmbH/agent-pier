import { useEffect, useRef, useState } from "react";
import { agentRunStepsCopy } from "../../lib/i18n/messages/agent-run-steps.js";

// The live steps of an agent's running turn, from the chat feed's `steps` frames
// (server/features/assistants/run-steps.js): only metadata, never output or text.

/** A turn waiting this long for the model without any sign of life is stalled. */
export const stallMs = 3 * 60 * 1000;
const phases = new Set([
  "model",
  "thinking",
  "writing",
  "tool",
  "approval",
  "compacting",
  "retrying",
]);
// A running tool (a long command), an exec approval and a compaction report nothing
// until they end: they are not stalled.
const busy = new Set(["tool", "approval", "compacting"]);
const states = new Set(["running", "done", "failed"]);

function step(value) {
  if (!value || typeof value.id !== "string") return null;
  const kind = value.kind === "thinking" ? "thinking" : "tool";
  return {
    id: value.id,
    kind,
    tool: typeof value.tool === "string" ? value.tool : "",
    label: typeof value.label === "string" ? value.label : "",
    state: states.has(value.state) ? value.state : "running",
  };
}

/**
 * The runs' steps after a feed frame: `steps` replaces a run's view and stamps when it
 * arrived, `steps-end` drops it. Null when the frame is not one of them.
 */
export function nextSteps(current, frame, now = Date.now()) {
  if (typeof frame?.runId !== "string") return null;
  if (frame.type === "steps-end") {
    if (!current.has(frame.runId)) return current;
    const next = new Map(current);
    next.delete(frame.runId);
    return next;
  }
  if (frame.type !== "steps" || !Array.isArray(frame.steps)) return null;
  const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
  const next = new Map(current);
  next.delete(frame.runId);
  next.set(frame.runId, {
    steps: frame.steps.map(step).filter(Boolean),
    omitted: count(frame.omitted),
    phase: phases.has(frame.phase) ? frame.phase : "model",
    retry: frame.retry
      ? { attempt: count(frame.retry.attempt), of: count(frame.retry.of) }
      : null,
    // When the last sign of life came, on this device's clock.
    quietSince: now - (Number.isFinite(frame.quietMs) ? Math.max(0, frame.quietMs) : 0),
  });
  // Only the newest few runs matter: the chat shows its latest turn.
  while (next.size > 8) next.delete(next.keys().next().value);
  return next;
}

/** The steps of the attempt's run, or null. */
export function stepsOf(runs, attempt) {
  if (!attempt) return null;
  return runs.get(attempt.runtimeRunId) || runs.get(attempt.id) || null;
}

/**
 * Whole minutes without a sign of life while the turn waits for the model, or 0
 * when it is not stalled.
 */
export function stalledMinutes(view, now = Date.now()) {
  if (!view || busy.has(view.phase)) return 0;
  const quiet = now - view.quietSince;
  return quiet >= stallMs ? Math.floor(quiet / 60000) : 0;
}

/** The current time, refreshed (and the caller rendered) every `ms` while `active`. */
export function useNow(active, ms = 15000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}

/**
 * Try again on a stalled or timed-out turn, for the owner's and a user's chat: the
 * turn stops (`stop`, when `active`) and the agent is asked to go on where it stopped
 * (`deliver`). One at a time: a second click while the stop runs does nothing, and
 * `setBusy` disables the chat's buttons meanwhile.
 */
export function useRetry({ active, stop, deliver, setBusy }) {
  const pending = useRef(false);
  return async function retry() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (active && !(await stop())) return;
      const text = agentRunStepsCopy.continueMessage;
      await deliver({ clientRequestId: crypto.randomUUID(), text }, []);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
}
