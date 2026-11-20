import { randomUUID } from "node:crypto";
import { hermesError } from "./hermes-rpc-client.js";
import { refused } from "./hermes-approval-queue.js";
import { storedIdOf } from "./hermes-run-state.js";
import { frozenSession, recapOf } from "./hermes-session-successors.js";

// How one connection reaches a session of a chat (hermes-sessions.js): attach, edit,
// read the transcript, and move a frozen session to a following one
// (hermes-session-successors.js). `link` is the connection's state
// (hermes-connection.js reachable) with the agent's `successors`.

// session.resume attaches the session and reads its state.
export const resumeTimeoutMs = 60000;

// Attaches in flight per connection, so two calls for one key share one attach.
const attaching = new WeakMap();
// What each session attached to a connection is: its reasoning level (session id →
// Hermes's `info.reasoning_effort`, "" for its default; null: unknown) and whether
// Hermes froze its route (frozenSession).
const levels = new WeakMap();
const frozen = new WeakMap();
const mapOf = (maps, client) => {
  let known = maps.get(client);
  if (!known) maps.set(client, (known = new Map()));
  return known;
};
const levelOf = (snapshot) =>
  typeof snapshot?.info?.reasoning_effort === "string"
    ? snapshot.info.reasoning_effort
    : null;

/** Whether a call failed because Hermes knows no such session. */
export const missing = (error) =>
  error?.answered === true && error.reason === "not_found";

/** Records what a snapshot of session `sid` tells about it on this connection. */
export function known(link, sid, snapshot) {
  mapOf(levels, link.client).set(sid, levelOf(snapshot));
  mapOf(frozen, link.client).set(sid, frozenSession(snapshot));
}

/** The chat's first stored session id and the chain its turns ran in, oldest first. */
export function chainOf(link, key) {
  const first = storedIdOf(link.agentId, key);
  if (!first) return { first: null, chain: [] };
  return { first, chain: link.successors ? link.successors.of(first) : [first] };
}

// Gives session `sid` (`key`) the home's thinking level (`wanted`) before its next
// turn when it runs another; a refusal (a turn under way) retries at the next turn.
export async function followReasoning(link, key, sid, wanted) {
  if (typeof wanted !== "string") return;
  const levelsHere = mapOf(levels, link.client);
  if (levelsHere.get(sid) === wanted) return;
  try {
    await mutate(link, key, "reasoning", { effort: null }, { fenced: true });
    levelsHere.set(sid, wanted);
  } catch {
    /* The turn runs at the level it has; the next one tries again. */
  }
}

// Attaches the session the chat behind `key` runs in to this connection; resolves its
// session id.
export async function attach(link, key) {
  const { chain } = chainOf(link, key);
  const stored = chain.at(-1);
  if (!stored) throw refused("unknown session key");
  const bound = link.runs.sidOf(key);
  if (bound) return bound;
  let pending = attaching.get(link.client);
  if (!pending) attaching.set(link.client, (pending = new Map()));
  if (!pending.has(key))
    pending.set(
      key,
      link.client
        .call(
          "session.resume",
          { session_id: stored, omit_messages: true },
          { timeoutMs: resumeTimeoutMs },
        )
        .then((snapshot) => {
          if (typeof snapshot?.session_id !== "string") throw hermesError("RPC_FAILED");
          link.runs.bind(key, snapshot.session_id, snapshot);
          known(link, snapshot.session_id, snapshot);
          // The title a successor's is made from (moveToSuccessor).
          const title = snapshot.info?.title;
          if (typeof title === "string" && title && !link.runs.titleOf(key))
            link.runs.titled(key, title);
          // Questions still waiting in the session are asked again here.
          link.approvals.reopened(snapshot.session_id, snapshot.prompts);
          link.questions.reopened(snapshot.session_id, snapshot.prompts);
          return snapshot.session_id;
        })
        .finally(() => pending.delete(key)),
    );
  return pending.get(key);
}

// One revision-fenced session.mutate of attached session `sid`; a refusal for an older
// revision or generation is repeated once with the fences it names, under the same
// request id.
async function mutateSid(link, sid, operation, payload, options) {
  const requestId = `${operation}-${randomUUID()}`;
  for (let attempt = 0; ; attempt++) {
    const { revision, generation } = link.runs.fences(sid);
    try {
      const receipt = await link.client.call(
        "session.mutate",
        {
          session_id: sid,
          request_id: requestId,
          expected_revision: revision,
          ...(options.fenced ? { expected_generation: generation } : {}),
          operation,
          payload,
        },
        options,
      );
      link.runs.fenced(sid, receipt);
      return receipt;
    } catch (error) {
      if (
        attempt > 0 ||
        error?.code !== "CONFLICT" ||
        error.reason === "admission_conflict"
      )
        throw error;
      link.runs.fenced(sid, error.fences);
    }
  }
}

/**
 * A revision-fenced edit of the session behind `key` (session.mutate): attached
 * first, so its fences are known.
 */
export async function mutate(link, key, operation, payload, options = {}) {
  return mutateSid(link, await attach(link, key), operation, payload, options);
}

/**
 * The same edit of each earlier session of the chat behind `key` (the sessions it ran
 * in before its successor, oldest first); one that is gone is skipped.
 */
export async function mutateEarlier(link, key, operation, payload, options = {}) {
  const { chain } = chainOf(link, key);
  for (const stored of chain.slice(0, -1)) {
    const hold = `earlier:${stored}`;
    try {
      const snapshot = await link.client.call(
        "session.resume",
        { session_id: stored, omit_messages: true },
        { timeoutMs: resumeTimeoutMs },
      );
      if (typeof snapshot?.session_id !== "string") continue;
      link.runs.bind(hold, snapshot.session_id, snapshot);
      await mutateSid(link, snapshot.session_id, operation, payload, options);
    } catch (error) {
      if (!missing(error)) throw error;
    } finally {
      link.runs.unbind(hold);
    }
  }
}

/**
 * The stored transcript of the chat behind `key`, readable without attaching: the
 * rows of each session it ran in, oldest first, as one session.history answer. An
 * earlier session that is gone adds nothing.
 */
export async function transcript(link, key, options) {
  const { chain } = chainOf(link, key);
  if (!chain.length) throw refused("unknown session key");
  const answers = [];
  for (const [index, stored] of chain.entries()) {
    try {
      answers.push(
        await link.client.call("session.history", { session_id: stored }, options),
      );
    } catch (error) {
      if (index === chain.length - 1 || !missing(error)) throw error;
    }
  }
  if (answers.length === 1) return answers[0];
  const rows = answers.flatMap((answer) =>
    Array.isArray(answer?.messages) ? answer.messages : [],
  );
  const count = answers.reduce(
    (sum, answer) =>
      sum +
      (Number.isSafeInteger(answer?.count)
        ? answer.count
        : Array.isArray(answer?.messages)
          ? answer.messages.length
          : 0),
    0,
  );
  return { ...answers.at(-1), messages: rows, count };
}

/** Whether session `sid` on this connection is one Hermes froze. */
export const isFrozen = (link, sid) => mapOf(frozen, link.client).get(sid) === true;

/**
 * Moves the chat behind `key`, whose session `sid` Hermes froze, to a new following
 * session (its successor), which starts with a note of the conversation so far;
 * resolves the successor's session id. Idempotent per frozen session: a retry gets
 * the successor Hermes created first.
 */
export async function moveToSuccessor(link, key) {
  const { first, chain } = chainOf(link, key);
  const stored = chain.at(-1);
  const title = link.runs.titleOf(key);
  const created = await link.client.call("session.create", {
    request_id: `agentpier-successor-${stored}`,
    title: `${title || "Chat"} (${stored.slice(-8)})`,
    follow_profile_config: true,
  });
  const sid = created?.session_id;
  if (typeof sid !== "string" || !sid) throw hermesError("RPC_FAILED");
  link.successors.add(first, created.stored_session_id || sid);
  link.runs.unbind(key);
  link.runs.bind(key, sid, created);
  known(link, sid, created);
  await noteSuccessor(link, key);
  return sid;
}

/**
 * Writes the note of the conversation so far into the chat's successor, once: the
 * rows of every earlier session. A successor without its note (a write that failed,
 * a restart in between) gets it before the chat's next turn.
 */
export async function noteSuccessor(link, key) {
  const { first, chain } = chainOf(link, key);
  if (chain.length < 2 || link.successors.noted(first)) return;
  const earlier = [];
  for (const stored of chain.slice(0, -1))
    try {
      const answer = await link.client.call("session.history", { session_id: stored });
      earlier.push(...(Array.isArray(answer?.messages) ? answer.messages : []));
    } catch (error) {
      if (!missing(error)) return;
    }
  const recap = recapOf(earlier);
  if (recap) {
    const answer = await link.client
      .call("agentpier.note", { session_id: chain.at(-1), text: recap })
      .catch(() => null);
    if (answer?.appended !== true) return;
  }
  link.successors.markNoted(first);
}
