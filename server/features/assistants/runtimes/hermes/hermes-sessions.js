import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { boundPort, reachable, unsupported } from "./hermes-connection.js";
import { HermesTurns } from "./hermes-turns.js";
import {
  inlineImages,
  notSubmitted,
  sentText,
  stageImages,
} from "./hermes-inline-images.js";
import { hermesError } from "./hermes-rpc-client.js";
import { refused } from "./hermes-approval-queue.js";
import { sessionKeyOf, storedIdOf } from "./hermes-run-state.js";
import {
  titlePrompt,
  titleSystemPrompt,
  titleTimeoutMs,
} from "../../team-plugin/chat-title.js";

// A create's room: Hermes stores the session before it answers; an attempt that timed
// out (after the client's call timeout) is repeated with the same `request_id`, which
// Hermes answers with the session it created first.
const createBudgetMs = 60000;
const minAttemptMs = 5000;
// session.resume attaches the session and reads its state.
const resumeTimeoutMs = 60000;
// The fixed request timeout of Hermes's one-shot call (agent/oneshot.py
// `run_oneshot`, `timeout=60.0`), which llm.oneshot does not let a caller raise: it
// passes the value explicitly, so `auxiliary.<task>.timeout` does not apply either.
// One attempt of the model therefore gets at most 60 s on Hermes's side, whatever
// AgentPier waits. Hermes retries a timed-out `memory_review` once on the same
// provider and may then fall back (agent/auxiliary_client.py
// `_should_skip_same_provider_retry`), so one call can take a multiple of it.
const oneshotTimeoutMs = 60000;
// How long a memory review waits for Hermes: 60 s per 4000 answer tokens (the
// review's budget), so the dream's 8000 leave room for Hermes's retry.
const reviewTimeoutMs = (maxTokens) =>
  Math.ceil((oneshotTimeoutMs * Math.max(maxTokens, 4000)) / 4000) + 5000;

// Attaches in flight per connection, so two calls for one key share one attach.
const attaching = new WeakMap();

const missing = (error) => error?.answered === true && error.reason === "not_found";

/**
 * The sessions sub-port (agent-runtime.js) over the session store of Hermes's
 * messaging gateway, reached through the RPC bridge. Keys are
 * `agent:<runtimeAgentId>:hermes:<session id>` (hermes-run-state.js). A call that
 * needs the session attached to this connection (a turn, an edit) attaches it first
 * (`session.resume`), so a key works across restarts. Methods: create →
 * session.create (`request_id` = idempotency key, `title` = the label, unique per
 * agent like OpenClaw's labels), send → prompt.submit (`submission_id` = run id),
 * abort → session.interrupt of the current execution generation (prompt.cancel for a
 * turn still queued), wait → the run's end as this connection saw it, describe and
 * get/history → session.history, list → session.list by title, compact, delete
 * (or archive keeping the transcript) and keepOpen → session.mutate (`compress`,
 * `delete`, `archive`) fenced on the session's revision, subscribeMessages → the
 * attach, title and reviewMemory → llm.oneshot. downloadArtifact is a capability
 * gap (UNSUPPORTED). `on(connection)` binds the methods to one connection
 * (hermes-connection.js).
 */
export function hermesSessions(supervisor) {
  // The turns AgentPier submitted, shared by every view (hermes-turns.js).
  const turns = new HermesTurns();
  // The last context size read per session key, beyond one connection (contextOf).
  const sizes = new Map();
  return boundPort(
    (current) => sessionsOver(current, turns, sizes, supervisor),
    supervisor,
  );
}

// Attaches the session behind `key` to this connection; resolves its session id.
async function attach(link, key) {
  const stored = storedIdOf(link.agentId, key);
  if (!stored) throw refused("unknown session key");
  const known = link.runs.sidOf(key);
  if (known) return known;
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
          // Questions still waiting in the session are asked again here.
          link.approvals.reopened(snapshot.session_id, snapshot.prompts);
          link.questions.reopened(snapshot.session_id, snapshot.prompts);
          return snapshot.session_id;
        })
        .finally(() => pending.delete(key)),
    );
  return pending.get(key);
}

/**
 * A revision-fenced edit of the session behind `key` (session.mutate): attached
 * first, so its fences are known; a refusal for an older revision or generation is
 * repeated once with the fences it names, under the same request id.
 */
async function mutate(link, key, operation, payload, options = {}) {
  const sid = await attach(link, key);
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

const describeRow = (link, key, row, sid) => ({
  key,
  sessionId: storedIdOf(link.agentId, key),
  agentId: link.agentId,
  label: row?.title || null,
  title: row?.title || null,
  messageCount: row?.message_count ?? 0,
  startedAt: row?.started_at ?? null,
  live: !!sid,
  running: !!sid && link.runs.busy(sid),
});

// User rows Hermes writes itself (tui_gateway/session_history.py display kinds): the
// note that resumes a turn an interruption cut off, and the notes of results no one
// watched, routine results included (agentpier.note), are never the owner's words.
const internalKinds = new Set(["auto_continue", "internal_notification"]);

/**
 * The port's history entry (agent-runtime.js sessions `entry`) of a Hermes history
 * row at `index` of the whole transcript. Hermes 0.22.5 sends `{ role, text,
 * timestamp, row_id, display_kind, … }` (session.history, _history_to_messages): the
 * durable `row_id` is its id (a row without one is named by its place), the
 * timestamp is in seconds, and a row names neither its turn's run nor its submission
 * (hermes-turns.js attributes the replies of the turns AgentPier sent).
 */
export function hermesEntry(row, index, homes = []) {
  const r = row && typeof row === "object" ? row : {};
  const rowId = r.row_id;
  const at = Number.isFinite(r.timestamp) && r.timestamp > 0 ? r.timestamp : 0;
  return {
    id:
      (typeof rowId === "number" && Number.isFinite(rowId)) ||
      (typeof rowId === "string" && rowId)
        ? `row:${rowId}`
        : `at:${index}`,
    role: r.role,
    // A user row reads as the text AgentPier sent (hermes-inline-images.js).
    text:
      typeof r.text !== "string"
        ? ""
        : r.role === "user"
          ? sentText(r.text, homes)
          : r.text,
    // Seconds; a value already in milliseconds is kept.
    timestamp: at > 0 && at < 1e11 ? Math.round(at * 1000) : Math.round(at),
    runId: null,
    turnKey: null,
    internal: r.role === "user" && internalKinds.has(r.display_kind),
    compaction: null,
  };
}

// Hermes's history rows, newest last, with OpenClaw's `content` beside its `text` and
// the port's `entry`; `attribute` names the runs of the rows (hermes-turns.js), read
// over the whole transcript before a page is cut.
const messagesOf = (answer, limit, attribute = (all) => all, homes = []) => {
  const rows = Array.isArray(answer?.messages) ? answer.messages : [];
  const all = attribute(
    rows.map((row, i) => {
      const entry = hermesEntry(row, i, homes);
      return typeof row?.text === "string"
        ? {
            ...row,
            text: entry.text,
            content: [{ type: "text", text: entry.text }],
            entry,
          }
        : { ...(row && typeof row === "object" ? row : {}), entry };
    }),
  );
  const from =
    Number.isSafeInteger(limit) && limit > 0 ? Math.max(0, all.length - limit) : 0;
  return all.slice(from);
};

const titleOf = (text) =>
  String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^["'“”]+|["'“”.]+$/g, "")
    .slice(0, 120) || "";

// The stored transcript of `key`: readable without attaching.
async function transcript(link, key, options) {
  const stored = storedIdOf(link.agentId, key);
  if (!stored) throw refused("unknown session key");
  return link.client.call("session.history", { session_id: stored }, options);
}

// How full the context of the session's last model call was, in OpenClaw's
// `sessionInfo` terms (conversations.js longContext): `session.stats`
// (gateway/session_usage.py) of the agent the gateway keeps for a session attached
// here: `last_prompt_tokens` against `context_length`. Hermes keeps that agent only
// in the gateway's memory (gateway/session_controls.py `stats`: no agent, no size)
// and stores no prompt size in its SessionDB, so after a gateway restart the size
// read last for the key (`sizes`, kept per agent beyond one connection) stands until
// the session's next model call: the history it measured is unchanged. A compression
// AgentPier asked for (compact) or a deletion forgets it; a size never read is none.
async function contextOf(link, key, sizes) {
  const sid = link.runs.sidOf(key);
  const known = () => sizes.get(key) ?? {};
  if (!sid) return known();
  try {
    const stats = await link.client.call(
      "session.stats",
      { session_id: sid },
      { timeoutMs: 10000 },
    );
    const used = stats?.last_prompt_tokens;
    const window = stats?.context_length;
    if (!Number.isSafeInteger(used) || used <= 0) return known();
    const size = {
      totalTokens: used,
      totalTokensFresh: true,
      ...(Number.isSafeInteger(window) && window > 0 && { contextTokens: window }),
    };
    sizes.set(key, size);
    return size;
  } catch {
    return known();
  }
}

// The spellings of the agent's HERMES_HOME, which names its turns' images (sentText).
function homesOf(supervisor) {
  const home = supervisor?.agentPaths?.().hermesHome;
  if (typeof home !== "string") return [];
  try {
    const real = fs.realpathSync(home);
    return real === home ? [home] : [home, real];
  } catch {
    return [home];
  }
}

function sessionsOver(current, turns, sizes = new Map(), supervisor = null) {
  let homes;
  const own = () => (homes ??= homesOf(supervisor));
  const reach = async () => reachable(current());
  return {
    async create({ agentId, label, idempotencyKey }, options = {}) {
      const link = await reach();
      const { budgetMs = createBudgetMs, now = Date.now, sleep = delay } = options;
      if (agentId !== link.agentId) throw refused("agent not served by this process");
      const params = {
        request_id: idempotencyKey || randomUUID(),
        ...(label ? { title: String(label) } : {}),
      };
      const deadline = now() + budgetMs;
      let created;
      for (;;) {
        try {
          created = await link.client.call("session.create", params, {
            timeoutMs: Math.max(1, Math.min(deadline - now(), link.client.timeoutMs)),
          });
          break;
        } catch (error) {
          if (error?.code !== "TIMEOUT" || deadline - now() < minAttemptMs) throw error;
          await sleep(100);
        }
      }
      const sid = created?.session_id;
      if (typeof sid !== "string" || !sid)
        throw Object.assign(hermesError("RPC_FAILED"), { created: true });
      const key = sessionKeyOf(link.agentId, created.stored_session_id || sid);
      // The create attached the session to this connection.
      link.runs.bind(key, sid, created);
      link.runs.titled(key, params.title);
      return { key };
    },
    // Hermes answers a refused create before it stores any session.
    notCreated: (error) => error?.answered === true && error.created !== true,
    async send({ key, turn, idempotencyKey, onLate }) {
      const link = await reach();
      const runId = idempotencyKey || randomUUID();
      // The message names every attached file by its path (agent-attachments.js); its
      // inline images go with it as Hermes's attachments (hermes-inline-images.js).
      const text = typeof turn?.message === "string" ? turn.message : "";
      const images = supervisor?.nativeImages === true ? inlineImages(turn) : [];
      for (let attempt = 0; ; attempt++) {
        const sid = await attach(link, key);
        // Staged before the run is known: a staging failure submitted nothing.
        let attachments;
        try {
          attachments = await stageImages(link.client, sid, images);
        } catch (error) {
          if (attempt === 0 && error?.answered && error.reason === "permission_denied") {
            link.runs.unbind(key);
            continue;
          }
          throw notSubmitted(error);
        }
        link.runs.submitted(sid, runId);
        try {
          const answer = await link.client.call(
            "prompt.submit",
            {
              session_id: sid,
              text,
              submission_id: runId,
              ...(attachments.length && { attachments }),
            },
            { onLate },
          );
          link.runs.admitted(sid, runId, answer?.admission_id);
          turns.record(key, runId, text);
          return { runId, status: answer?.status ?? null };
        } catch (error) {
          // An answered refusal admitted nothing; a timeout may still run the turn.
          if (!error?.answered) throw error;
          link.runs.withdrawn(sid, runId);
          // A session this connection is no longer attached to is attached again.
          if (attempt > 0 || error.reason !== "permission_denied") throw error;
          link.runs.unbind(key);
        }
      }
    },
    async abort({ key, runId }) {
      const link = await reach();
      const sid = link.runs.sidOf(key);
      // A session not attached here runs nothing this connection started.
      if (!sid || !link.runs.busy(sid))
        return { status: "not_interrupted", interrupted: false };
      const admission = runId && link.runs.admissionOf(sid, runId);
      if (admission && link.runs.runOf(sid) !== runId) {
        // Still queued behind the running turn: retired before it starts.
        await link.client.call("prompt.cancel", {
          session_id: sid,
          admission_id: admission,
        });
        return { status: "cancelled", interrupted: true };
      }
      const interrupt = (generation) =>
        link.client.call("session.interrupt", {
          session_id: sid,
          execution_generation: generation,
        });
      try {
        await interrupt(link.runs.fences(sid).generation);
      } catch (error) {
        if (error?.reason !== "stale_generation" || !error.fences?.execution_generation)
          throw error;
        link.runs.fenced(sid, error.fences);
        await interrupt(error.fences.execution_generation);
      }
      return { status: "interrupted", interrupted: true };
    },
    async wait({ runId, waitMs }) {
      const link = await reach();
      return link.runs.wait(runId, waitMs);
    },
    async describe({ key }) {
      const link = await reach();
      if (!storedIdOf(link.agentId, key)) return { session: null };
      let answer;
      try {
        answer = await transcript(link, key);
      } catch (error) {
        if (missing(error)) return { session: null };
        throw error;
      }
      const sid = link.runs.sidOf(key);
      const row = { title: link.runs.titleOf(key), message_count: answer?.count ?? 0 };
      return { session: describeRow(link, key, row, sid) };
    },
    async list({ agentId, label }) {
      const link = await reach();
      if (agentId !== link.agentId || !label) return [];
      // Titles are unique: the lookup answers the session holding the label, or none.
      const { sessions = [] } = await link.client.call("session.list", {
        title: String(label),
      });
      return sessions
        .filter((row) => typeof row?.id === "string" && row.title === label)
        .map((row) => {
          const key = sessionKeyOf(link.agentId, row.resolved_id || row.id);
          link.runs.titled(key, row.title);
          return describeRow(link, key, row, link.runs.sidOf(key));
        });
    },
    async get({ key, limit, timeoutMs }) {
      const link = await reach();
      const answer = await transcript(link, key, { timeoutMs });
      return {
        messages: messagesOf(answer, limit, turns.attribute.bind(turns, key), own()),
      };
    },
    async history({ sessionKey, limit, offset, maxChars }) {
      const link = await reach();
      const answer = await transcript(link, sessionKey);
      let messages = messagesOf(
        answer,
        undefined,
        turns.attribute.bind(turns, sessionKey),
        own(),
      );
      const total = messages.length;
      const skip = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
      const end = total - skip;
      const start =
        Number.isSafeInteger(limit) && limit > 0 ? Math.max(0, end - limit) : 0;
      messages = messages.slice(start, Math.max(0, end));
      if (Number.isSafeInteger(maxChars) && maxChars > 0)
        messages = messages.map((m) =>
          typeof m?.text === "string" && m.text.length > maxChars
            ? {
                ...m,
                text: m.text.slice(0, maxChars),
                content: [{ type: "text", text: m.text.slice(0, maxChars) }],
                entry: { ...m.entry, text: m.text.slice(0, maxChars) },
                truncated: true,
              }
            : m,
        );
      return {
        messages,
        sessionInfo: {
          key: sessionKey,
          count: answer?.count ?? total,
          ...(await contextOf(link, sessionKey, sizes)),
        },
        hasMore: start > 0,
        sessionId: storedIdOf(link.agentId, sessionKey),
      };
    },
    async delete({ key, deleteTranscript }) {
      const link = await reach();
      if (!storedIdOf(link.agentId, key)) throw refused("unknown session key");
      try {
        // Archiving keeps the transcript; Hermes refuses to delete a running session.
        const receipt =
          deleteTranscript === false
            ? await mutate(link, key, "archive", { archived: true })
            : await mutate(link, key, "delete", {}, { fenced: true });
        if (deleteTranscript !== false) {
          link.runs.unbind(key);
          turns.forget(key);
          sizes.delete(key);
        }
        return receipt;
      } catch (error) {
        if (!missing(error)) throw error;
        link.runs.unbind(key);
        return { deleted: null };
      }
    },
    // Hermes's own maintenance never archives an AgentPier session; an archived one
    // is restored with its history.
    async keepOpen({ key }) {
      const link = await reach();
      try {
        await mutate(link, key, "archive", { archived: false });
      } catch (error) {
        if (missing(error)) return "missing";
        throw error;
      }
      return "open";
    },
    // Hermes refuses no turn of an archived session, so no refused turn goes again.
    reopenRefused: async () => false,
    async compact({ key, timeoutMs }) {
      const link = await reach();
      // The compressed history is shorter: its size is unknown until the next call.
      sizes.delete(key);
      return mutate(link, key, "compress", {}, { fenced: true, timeoutMs });
    },
    // A session's events reach every connection attached to it: attaching here is
    // the subscription.
    async subscribeMessages({ key }) {
      const link = await reach();
      await attach(link, key);
      return { subscribed: true };
    },
    async downloadArtifact() {
      await reach();
      throw unsupported("sessions.downloadArtifact");
    },
    // Background processes Hermes started are reported as notifications, not
    // queryable per session: a session runs background work only while its turn does.
    async backgroundRunning({ key }) {
      const link = await reach();
      const sid = link.runs.sidOf(key);
      return !!sid && link.runs.busy(sid);
    },
    // A title from the agent's own model outside any session (Hermes llm.oneshot,
    // the title_generation task), from the same prompt OpenClaw's plugin sends.
    async title({ message, reply }) {
      const link = await reach();
      const answer = await link.client.call(
        "llm.oneshot",
        {
          task: "title_generation",
          instructions: titleSystemPrompt,
          input: titlePrompt({ message, reply }),
          max_tokens: 256,
        },
        { timeoutMs: titleTimeoutMs + 5000 },
      );
      const title = titleOf(answer?.text);
      if (!title) throw refused("no title");
      return { title };
    },
    // The memory review after a model switch (memory-review.js) as one llm.oneshot
    // outside any session. Without a session Hermes runs a task it has no
    // `auxiliary.<task>` route for on the agent's main model (agent/auxiliary_client.py
    // `_resolve_task_provider_model`, `_resolve_auto_route`), so on its new model.
    // The nightly dream (hermes-dream.js) asks the same way with more room.
    async reviewMemory({ instructions, input, maxTokens = 4000 }) {
      const link = await reach();
      const answer = await link.client.call(
        "llm.oneshot",
        { task: "memory_review", instructions, input, max_tokens: maxTokens },
        { timeoutMs: reviewTimeoutMs(maxTokens) },
      );
      return { text: typeof answer?.text === "string" ? answer.text : "" };
    },
  };
}
