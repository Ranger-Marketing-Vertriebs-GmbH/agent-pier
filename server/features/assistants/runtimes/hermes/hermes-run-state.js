// What one Hermes connection knows of its sessions and runs: which AgentPier session
// key a live Hermes session id belongs to, which run a turn is, how runs ended, and
// the run events (agent-runtime.js events.subscribe) they make.
//
// Session keys: Hermes names a session twice, by its live id in this process
// (`session_id`, gone with the process) and by its stored id (`stored_session_id`,
// durable in its state.db). AgentPier keeps `agent:<runtimeAgentId>:hermes:<stored>`,
// so a key outlives a restart, names its agent as OpenClaw's keys do, and stays unique
// across agents; the adapter resumes a stored session into the process when a call
// needs it live (hermes-sessions.js).
//
// Runs: Hermes has no run id. A turn AgentPier submits takes its idempotency key as
// run id (as OpenClaw's sessions.send); the key waits in the session's queue until the
// turn's `message.start`, so a turn Hermes queued behind a running one keeps its own
// id. A turn AgentPier did not submit (a background completion) is `hermes-turn:<id>`.

const keyPrefix = (agentId) => `agent:${agentId}:hermes:`;
// Event types that belong to a running turn even when its message.start was missed.
const turnTypes = /^(?:message\.|tool\.|thinking\.|reasoning\.)/;
const toolTypes = new Set([
  "tool.generating",
  "tool.start",
  "tool.progress",
  "tool.complete",
]);
const endKinds = { complete: "finished", interrupted: "aborted" };
// How many ended runs a connection remembers for wait().
const keptOutcomes = 256;

/** The AgentPier session key of a stored Hermes session of `agentId`. */
export const sessionKeyOf = (agentId, stored) => `${keyPrefix(agentId)}${stored}`;

/** The stored Hermes session id an AgentPier key names for `agentId`, or null. */
export function storedIdOf(agentId, key) {
  const prefix = keyPrefix(agentId);
  if (typeof key !== "string" || !key.startsWith(prefix)) return null;
  const stored = key.slice(prefix.length);
  return stored && stored.length <= 200 ? stored : null;
}

// Why a turn failed, as the port names it: "timeout" for any kind of timeout, else
// Hermes's own failure reason or error code (agent/error_surface.py), or null.
function failureReason(payload) {
  const raw = payload?.failure_reason ?? payload?.error_surface?.code ?? null;
  if (typeof raw !== "string" || !raw) return null;
  return /time[ds]?[_\s-]?out/i.test(raw) ? "timeout" : raw.slice(0, 60);
}

/**
 * The port's kind of one Hermes event (agent-runtime.js RUN_EVENT_KINDS): a turn's
 * `message.start` starts it, `message.delta` is reply text, `tool.*` its tool steps,
 * `message.complete` ends it (status complete, interrupted or error) and an `error`
 * event fails a turn that never completed. Anything else is a sign of life of a
 * running turn ("progress"), or "other" outside any.
 */
export function hermesEventKind(type, payload, inRun) {
  if (type === "message.start") return "started";
  if (type === "message.delta") return "text";
  if (toolTypes.has(type)) return "tool";
  if (type === "message.complete") return endKinds[payload?.status] || "failed";
  if (type === "error") return inRun ? "failed" : "other";
  return inRun ? "progress" : "other";
}

const ending = new Set(["finished", "aborted", "failed"]);

export class HermesRuns {
  constructor(client, { agentId }) {
    Object.assign(this, { client, agentId });
    this.keys = new Map();
    this.sids = new Map();
    // Per live session id: `{ queue: [runId], current: runId | null, seq }`.
    this.turns = new Map();
    this.outcomes = new Map();
    this.waiters = new Map();
    this.listeners = new Set();
    client.subscribe((params) => this.observe(params));
    client.once("disconnected", () => this.dropped());
  }

  /** Records that live session `sid` is the stored session behind `key`. */
  bind(key, sid) {
    const before = this.sids.get(key);
    if (before && before !== sid) this.keys.delete(before);
    this.keys.set(sid, key);
    this.sids.set(key, sid);
  }

  unbind(key) {
    const sid = this.sids.get(key);
    this.sids.delete(key);
    if (sid) {
      this.keys.delete(sid);
      this.turns.delete(sid);
    }
  }

  keyOf = (sid) => this.keys.get(sid) ?? null;
  sidOf = (key) => this.sids.get(key) ?? null;
  liveKeys = () => [...this.sids.keys()];

  turn(sid) {
    let turn = this.turns.get(sid);
    if (!turn) this.turns.set(sid, (turn = { queue: [], current: null, seq: 0 }));
    return turn;
  }

  /** The run under way in live session `sid`, or null. */
  runOf = (sid) => this.turns.get(sid)?.current ?? null;

  /** Whether a turn of live session `sid` runs or waits to run. */
  busy = (sid) => {
    const turn = this.turns.get(sid);
    return !!turn && (!!turn.current || turn.queue.length > 0);
  };

  /** A turn AgentPier is about to submit: its run id waits for its message.start. */
  submitted(sid, runId) {
    this.turn(sid).queue.push(runId);
  }

  /** A submit Hermes refused or never answered: its run id never starts. */
  withdrawn(sid, runId) {
    const turn = this.turns.get(sid);
    if (turn) turn.queue = turn.queue.filter((id) => id !== runId);
  }

  observe(params) {
    const { type, session_id: sid } = params || {};
    if (typeof type !== "string") return;
    const payload =
      params.payload && typeof params.payload === "object" ? params.payload : {};
    const turn = typeof sid === "string" && sid ? this.turn(sid) : null;
    // A replayed frame (session.events.since) this connection saw already.
    if (turn && Number.isSafeInteger(params.seq)) {
      if (params.seq <= turn.seq) return;
      turn.seq = params.seq;
    }
    if (turn && (type === "message.start" || (!turn.current && turnTypes.test(type))))
      turn.current ??=
        turn.queue.shift() ??
        `hermes-turn:${payload.turn_id || params.seq || Date.now()}`;
    // An error that ends a submitted turn which never started fails that turn.
    if (turn && type === "error" && !turn.current && turn.queue.length)
      turn.current = turn.queue.shift();
    const runId = turn?.current ?? null;
    const kind = hermesEventKind(type, payload, !!runId);
    const sessionKey = typeof sid === "string" ? this.keyOf(sid) : null;
    const reason = kind === "failed" ? failureReason(payload) : null;
    this.emit({
      kind,
      sessionKey,
      runId,
      reason,
      event: type,
      // Hermes's own payload, with the session key and run id OpenClaw's carry.
      payload: { ...payload, sessionKey, runId },
    });
    if (runId && ending.has(kind)) {
      turn.current = null;
      this.ended(runId, kind, reason);
    }
  }

  ended(runId, kind, reason) {
    const outcome =
      kind === "finished"
        ? { runId, status: "ok" }
        : kind === "aborted"
          ? { runId, status: "aborted", aborted: true }
          : { runId, status: "error", reason };
    this.outcomes.set(runId, outcome);
    if (this.outcomes.size > keptOutcomes)
      this.outcomes.delete(this.outcomes.keys().next().value);
    for (const wake of this.waiters.get(runId) || []) wake(outcome);
    this.waiters.delete(runId);
  }

  /** The run's outcome once it ended, waiting up to `waitMs`; status "timeout" else. */
  async wait(runId, waitMs = 0) {
    const known = this.outcomes.get(runId);
    if (known) return { ...known };
    if (!(waitMs > 0) || this.client.closed) return { runId, status: "timeout" };
    return new Promise((resolve) => {
      const wake = (outcome) => {
        clearTimeout(timer);
        resolve({ ...outcome });
      };
      const timer = setTimeout(() => {
        this.waiters.get(runId)?.delete(wake);
        resolve({ runId, status: "timeout" });
      }, waitMs);
      if (!this.waiters.has(runId)) this.waiters.set(runId, new Set());
      this.waiters.get(runId).add(wake);
    });
  }

  subscribe(listener) {
    if (this.client.closed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* One failing listener must not stop the others. */
      }
    }
  }

  // A closed connection sends nothing more; its runs' outcomes stay unknown there.
  dropped() {
    this.listeners.clear();
    for (const [runId, wakes] of this.waiters)
      for (const wake of wakes) wake({ runId, status: "timeout" });
    this.waiters.clear();
  }
}
