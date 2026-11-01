// What one Hermes connection knows of its sessions and runs: which AgentPier session
// key a live Hermes session id belongs to, which run a turn is, how runs ended, and
// the run events (agent-runtime.js events.subscribe) they make.
//
// Session keys: the gateway's session store names a session by its durable id
// (`session_id`, equal to `stored_session_id`, kept in its state.db), and a connection
// attaches to it (`session.resume`, one subscription per connection) before it may
// submit there. AgentPier keeps `agent:<runtimeAgentId>:hermes:<stored>`, so a key
// outlives a restart, names its agent as OpenClaw's keys do, and stays unique across
// agents; the adapter attaches a session when a call needs it (hermes-sessions.js).
//
// Runs: a turn AgentPier submits takes its idempotency key as run id (as OpenClaw's
// sessions.send) and as Hermes's `submission_id`; Hermes answers with the turn's
// `admission_id`, which every frame of the turn carries. A run id waits in the
// session's queue only while its submit is unanswered, so a turn whose answer was
// lost still keeps its id. A turn AgentPier did not submit (a routine, a channel
// message) is `hermes-turn:<admission id>`.
//
// Fences: Hermes refuses a control (interrupt, approval answer) for another
// execution generation than the session's current one, and a session edit
// (`session.mutate`) for another revision. Both are read from the attach snapshot
// and from the frames: `execution_generation` on a turn's frames, `revision` on
// `session.info` and `session.updated`.

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

// Takes the newer execution generation and revision `values` name.
function fence(turn, values) {
  const generation = values?.execution_generation;
  const revision = values?.revision;
  if (Number.isSafeInteger(generation) && generation >= turn.generation)
    turn.generation = generation;
  if (Number.isSafeInteger(revision) && revision >= turn.revision)
    turn.revision = revision;
}

export class HermesRuns {
  constructor(client, { agentId }) {
    Object.assign(this, { client, agentId });
    this.keys = new Map();
    this.sids = new Map();
    // Per session id: `{ queue: [runId], current: runId | null, seq, admissions:
    // Map(admission id → runId), generation, revision, subscription }`.
    this.turns = new Map();
    this.outcomes = new Map();
    this.waiters = new Map();
    this.listeners = new Set();
    // The title each key was last seen with (create, list, a rename).
    this.titles = new Map();
    client.subscribe((params) => this.observe(params));
    client.once("disconnected", () => this.dropped());
  }

  /** Records that live session `sid` is the stored session behind `key`. */
  bind(key, sid, snapshot) {
    const before = this.sids.get(key);
    if (before && before !== sid) this.keys.delete(before);
    this.keys.set(sid, key);
    this.sids.set(key, sid);
    if (snapshot && typeof snapshot === "object") {
      const turn = this.turn(sid);
      fence(turn, snapshot);
      if (typeof snapshot.subscription_id === "string")
        turn.subscription = snapshot.subscription_id;
    }
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
    if (!turn)
      this.turns.set(
        sid,
        (turn = {
          queue: [],
          current: null,
          seq: 0,
          admissions: new Map(),
          // Admitted runs that have not ended yet.
          open: new Set(),
          generation: 0,
          revision: 0,
          subscription: null,
        }),
      );
    return turn;
  }

  /** The fences of session `sid` as this connection saw them last. */
  fences(sid) {
    const turn = this.turns.get(sid);
    return {
      generation: turn?.generation ?? 0,
      revision: turn?.revision ?? 0,
      subscription: turn?.subscription ?? null,
    };
  }

  /** Records fences Hermes answered (a snapshot, an edit's receipt, a refusal's data). */
  fenced(sid, values) {
    fence(this.turn(sid), values);
  }

  /** The run under way in live session `sid`, or null. */
  runOf = (sid) => this.turns.get(sid)?.current ?? null;

  /** Whether a turn of session `sid` runs or waits to run. */
  busy = (sid) => {
    const turn = this.turns.get(sid);
    return !!turn && (!!turn.current || turn.queue.length > 0 || turn.open.size > 0);
  };

  /** A turn AgentPier is about to submit: its run id waits for Hermes's answer. */
  submitted(sid, runId) {
    const turn = this.turn(sid);
    // A repeated submit of the same id is the same admission (Hermes deduplicates).
    if (turn.queue.includes(runId) || [...turn.admissions.values()].includes(runId))
      return;
    turn.queue.push(runId);
  }

  /** Hermes admitted run `runId` as `admission`: its frames carry that id. */
  admitted(sid, runId, admission) {
    const turn = this.turn(sid);
    turn.queue = turn.queue.filter((id) => id !== runId);
    if (typeof admission === "string" && admission && !turn.admissions.has(admission))
      turn.admissions.set(admission, runId);
    if (!this.outcomes.has(runId)) turn.open.add(runId);
  }

  /** The run of `turn` a frame of `admission` starts. */
  runFor(turn, admission, fallback) {
    if (admission && turn.admissions.has(admission))
      return turn.admissions.get(admission);
    // A frame before the submit's answer: the oldest unanswered submit is that turn.
    const runId = turn.queue.shift() ?? `hermes-turn:${admission || fallback}`;
    if (admission) turn.admissions.set(admission, runId);
    return runId;
  }

  /** The admission id run `runId` of session `sid` was admitted as, or null. */
  admissionOf(sid, runId) {
    for (const [admission, id] of this.turns.get(sid)?.admissions || [])
      if (id === runId) return admission;
    return null;
  }

  /** Records the title `key`'s session holds; titleOf(key) reads it back. */
  titled(key, title) {
    if (typeof title === "string" && title) this.titles.set(key, title);
  }

  titleOf = (key) => this.titles.get(key) ?? null;

  /** The run admission `admission` of session `sid` is, or null. */
  runOfAdmission = (sid, admission) =>
    (admission && this.turns.get(sid)?.admissions.get(admission)) || null;

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
    const admission =
      typeof params.admission_id === "string" && params.admission_id
        ? params.admission_id
        : null;
    if (turn) {
      fence(turn, { execution_generation: params.execution_generation });
      if (type === "session.info" || type === "session.updated") fence(turn, payload);
      if (type === "session.updated" && this.keys.has(sid))
        this.titled(this.keys.get(sid), payload.title);
    }
    if (turn && (type === "message.start" || (!turn.current && turnTypes.test(type))))
      turn.current ??= this.runFor(
        turn,
        admission,
        payload.turn_id || params.seq || Date.now(),
      );
    // An error that ends a submitted turn which never started fails that turn.
    if (
      turn &&
      type === "error" &&
      !turn.current &&
      (admission ? turn.admissions.has(admission) : turn.queue.length > 0)
    )
      turn.current = this.runFor(turn, admission, params.seq || Date.now());
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
      turn.open.delete(runId);
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
