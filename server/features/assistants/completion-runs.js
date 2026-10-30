import { isDeepStrictEqual } from "node:util";

// OpenClaw's own run after a background command. An owner turn that starts a long
// `exec` ends while the command keeps running; when it exits, OpenClaw
// (`tools.exec.notifyOnExit`, on by default) runs the same session once more without
// an AgentPier attempt: 2026.10.3 (and older) through its heartbeat runner, whose
// agent events carry `isHeartbeat: true`; 2026.10.7 as an ordinary event turn with no
// mark (the team plugin counts those, background-commands.js). Both write the
// completion's user entry with the input provenance
// `{ kind: "internal_system", sourceTool: "exec" }`. Such a run works like any run
// of its chat (owner-runs.js); AgentPier only needs to know that it runs (a work
// goal waits for it, work-goal-nudges.js) and, for Telegram, that it was one
// (telegram-follow-ups.js).

/** How long a marked run counts as live at most. */
export const completionWindowMs = 2 * 3600000;
const maxRuns = 64;

/** The live heartbeat-driven runs, by session, from the Gateway's agent events. */
export class CompletionRuns {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.runs = new Map();
  }
  /** Takes every Gateway `agent` event. */
  observe(payload) {
    const { runId, sessionKey } = payload || {};
    if (typeof runId !== "string" || typeof sessionKey !== "string") return;
    const phase = payload.data?.phase;
    const run = this.runs.get(runId);
    if (payload.stream === "lifecycle" && ["end", "error"].includes(phase))
      return void this.runs.delete(runId);
    if (run && run.sessionKey !== sessionKey) return void this.runs.delete(runId);
    if (payload.isHeartbeat === false) return void (run && this.runs.delete(runId));
    if (payload.isHeartbeat !== true || run) return;
    this.runs.set(runId, { runId, sessionKey, at: this.now() });
    if (this.runs.size > maxRuns) this.runs.delete(this.runs.keys().next().value);
  }
  /** The runs live in this session. */
  live(sessionKey) {
    const now = this.now();
    for (const [id, run] of this.runs)
      if (now - run.at > completionWindowMs) this.runs.delete(id);
    return [...this.runs.values()].filter((r) => r.sessionKey === sessionKey);
  }
  clear() {
    this.runs.clear();
  }
}

const execProvenance = { kind: "internal_system", sourceTool: "exec" };
export const completionTranscriptLimit = 200;
/**
 * Whether a `sessions.get` page shows `runId` as an exec completion run: the entry
 * right before the run's first record (`__openclaw.runId`) is a user entry with
 * exactly the exec provenance. Telegram delivery of a follow-up run's reply needs no
 * more (telegram-follow-ups.js): it grants nothing.
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
