import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { boundPort, reachable, unsupported } from "./hermes-connection.js";
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
 * attach, title → llm.oneshot. downloadArtifact is a capability gap (UNSUPPORTED).
 * `on(connection)` binds the methods to one connection (hermes-connection.js).
 */
export const hermesSessions = (supervisor) => boundPort(sessionsOver, supervisor);

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

// Hermes's history rows, newest last, with OpenClaw's `content` beside its `text`.
const messagesOf = (answer, limit) => {
  const rows = Array.isArray(answer?.messages) ? answer.messages : [];
  const kept = Number.isSafeInteger(limit) && limit > 0 ? rows.slice(-limit) : rows;
  return kept.map((row) =>
    typeof row?.text === "string"
      ? { ...row, content: [{ type: "text", text: row.text }] }
      : row,
  );
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

function sessionsOver(current) {
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
      // The turn's text only: inline images (`turn.attachments`) are not sent yet; the
      // message names every attached file by its path (agent-attachments.js).
      const text = typeof turn?.message === "string" ? turn.message : "";
      for (let attempt = 0; ; attempt++) {
        const sid = await attach(link, key);
        link.runs.submitted(sid, runId);
        try {
          const answer = await link.client.call(
            "prompt.submit",
            { session_id: sid, text, submission_id: runId },
            { onLate },
          );
          link.runs.admitted(sid, runId, answer?.admission_id);
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
      return { messages: messagesOf(answer, limit) };
    },
    async history({ sessionKey, limit, offset, maxChars }) {
      const link = await reach();
      const answer = await transcript(link, sessionKey);
      let messages = messagesOf(answer, undefined);
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
                truncated: true,
              }
            : m,
        );
      return {
        messages,
        sessionInfo: { key: sessionKey, count: answer?.count ?? total },
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
        if (deleteTranscript !== false) link.runs.unbind(key);
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
  };
}
