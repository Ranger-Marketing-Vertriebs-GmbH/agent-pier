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

// A create's room: Hermes builds its agent lazily, so session.create answers at once;
// an attempt that timed out (after the client's call timeout) is repeated with the same
// idempotency key, which Hermes answers with the session it created first
// (methods_session.py `_create_session`).
const createBudgetMs = 60000;
const minAttemptMs = 5000;
// session.resume of a stored session reads its transcript.
const resumeTimeoutMs = 60000;
// How many stored sessions a lookup reads (session.list answers newest first).
const listLimit = 1000;
const notFound = new Set([4001, 4007]);

// Resumes in flight per connection, so two calls for one key share one live session.
const resuming = new WeakMap();

/**
 * The sessions sub-port (agent-runtime.js) over Hermes's TUI gateway. Keys are
 * `agent:<runtimeAgentId>:hermes:<stored session id>` (hermes-run-state.js); a call
 * that needs the session live in the process resumes the stored one first
 * (`session.resume`), so a key works across restarts and after Hermes let an idle
 * session go. Methods: create → session.create (idempotency key) + session.title
 * (the label, which also stores the session at once), send → prompt.submit, abort →
 * session.interrupt, wait → the run's end as this connection saw it, describe/list →
 * session.list, get/history → session.history, compact → session.compress, delete →
 * session.close + session.delete (or session.archive keeping the transcript),
 * keepOpen → session.archive { archived: false }, subscribeMessages → the session is
 * live here, title → llm.oneshot. downloadArtifact is a capability gap (UNSUPPORTED).
 * `on(connection)` binds the methods to one connection (hermes-connection.js).
 */
export const hermesSessions = (supervisor) => boundPort(sessionsOver, supervisor);

// The live session id behind `key` in this connection, resuming it when needed.
async function live(link, key) {
  const stored = storedIdOf(link.agentId, key);
  if (!stored) throw refused("unknown session key");
  const known = link.runs.sidOf(key);
  if (known) return known;
  let pending = resuming.get(link.client);
  if (!pending) resuming.set(link.client, (pending = new Map()));
  if (!pending.has(key))
    pending.set(
      key,
      link.client
        .call("session.resume", { session_id: stored }, { timeoutMs: resumeTimeoutMs })
        .then((resumed) => {
          if (typeof resumed?.session_id !== "string") throw hermesError("RPC_FAILED");
          link.runs.bind(key, resumed.session_id);
          // Questions still waiting in the session are asked again here.
          for (const frame of resumed.open_requests || []) link.client.serve(frame);
          return resumed.session_id;
        })
        .finally(() => pending.delete(key)),
    );
  return pending.get(key);
}

// A call on the live session; a live id Hermes no longer holds is resumed once more.
async function onLive(link, key, method, params = {}, options = {}) {
  for (let attempt = 0; ; attempt++) {
    const sid = await live(link, key);
    try {
      return await link.client.call(method, { ...params, session_id: sid }, options);
    } catch (error) {
      if (attempt > 0 || !error?.answered || error.hermesCode !== 4001) throw error;
      link.runs.unbind(key);
    }
  }
}

// The stored session row of `stored`, or null.
async function storedRow(link, stored) {
  const { sessions = [] } = await link.client.call("session.list", {
    limit: listLimit,
    include_hidden: true,
  });
  return (
    sessions.find((row) => row?.id === stored || row?.resolved_id === stored) || null
  );
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

function sessionsOver(current) {
  const reach = async () => reachable(current());
  return {
    async create({ agentId, label, idempotencyKey }, options = {}) {
      const link = await reach();
      const { budgetMs = createBudgetMs, now = Date.now, sleep = delay } = options;
      if (agentId !== link.agentId) throw refused("agent not served by this process");
      const params = { idempotency_key: idempotencyKey || randomUUID() };
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
      const { session_id: sid, stored_session_id: stored } = created || {};
      if (typeof sid !== "string" || typeof stored !== "string")
        throw Object.assign(hermesError("RPC_FAILED"), { created: true });
      const key = sessionKeyOf(link.agentId, stored);
      link.runs.bind(key, sid);
      // The label is the session's title; setting it stores the session right away,
      // so list() finds it and a restart keeps it before its first turn.
      if (label)
        await link.client
          .call("session.title", { session_id: sid, title: String(label) })
          .catch((error) => {
            throw Object.assign(hermesError(error?.code || "RPC_FAILED"), {
              created: true,
            });
          });
      return { key };
    },
    // Hermes answers a refused create before it registers any session.
    notCreated: (error) => error?.answered === true && error.created !== true,
    async send({ key, turn, idempotencyKey, onLate }) {
      const link = await reach();
      const runId = idempotencyKey || randomUUID();
      // The turn's text only: inline images (`turn.attachments`) are not sent yet; the
      // message names every attached file by its path (agent-attachments.js).
      const text = typeof turn?.message === "string" ? turn.message : "";
      for (let attempt = 0; ; attempt++) {
        const sid = await live(link, key);
        link.runs.submitted(sid, runId);
        try {
          const answer = await link.client.call(
            "prompt.submit",
            { session_id: sid, text },
            { onLate },
          );
          if (answer?.status === "rejected") {
            link.runs.withdrawn(sid, runId);
            throw refused("turn rejected while busy");
          }
          return { runId, status: answer?.status ?? null };
        } catch (error) {
          // An answered refusal submitted nothing; a timeout may still run the turn.
          if (!error?.answered) throw error;
          link.runs.withdrawn(sid, runId);
          if (attempt > 0 || error.hermesCode !== 4001) throw error;
          link.runs.unbind(key);
        }
      }
    },
    async abort({ key }) {
      const link = await reach();
      const sid = link.runs.sidOf(key);
      // A session not live in this process runs nothing.
      if (!sid) return { status: "not_interrupted", interrupted: false };
      return link.client.call("session.interrupt", { session_id: sid });
    },
    async wait({ runId, waitMs }) {
      const link = await reach();
      return link.runs.wait(runId, waitMs);
    },
    async describe({ key }) {
      const link = await reach();
      const stored = storedIdOf(link.agentId, key);
      if (!stored) return { session: null };
      const sid = link.runs.sidOf(key);
      const row = await storedRow(link, stored);
      return { session: row || sid ? describeRow(link, key, row, sid) : null };
    },
    async list({ agentId, label }) {
      const link = await reach();
      if (agentId !== link.agentId || !label) return [];
      const { sessions = [] } = await link.client.call("session.list", {
        title: String(label),
      });
      return sessions
        .filter((row) => typeof row?.id === "string" && row.title === label)
        .map((row) => {
          const key = sessionKeyOf(link.agentId, row.id);
          return describeRow(link, key, row, link.runs.sidOf(key));
        });
    },
    async get({ key, limit, timeoutMs }) {
      const link = await reach();
      const answer = await onLive(link, key, "session.history", {}, { timeoutMs });
      return { messages: messagesOf(answer, limit) };
    },
    async history({ sessionKey, limit, offset, maxChars }) {
      const link = await reach();
      const answer = await onLive(link, sessionKey, "session.history");
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
      const stored = storedIdOf(link.agentId, key);
      if (!stored) throw refused("unknown session key");
      // Hermes refuses to delete a session that is live in the process.
      const sid = link.runs.sidOf(key);
      if (sid) {
        await link.client.call("session.close", { session_id: sid });
        link.runs.unbind(key);
      }
      const ignoreMissing = (error) => {
        if (!(error?.answered && notFound.has(error.hermesCode))) throw error;
        return { deleted: null };
      };
      if (deleteTranscript === false)
        return link.client
          .call("session.archive", { session_id: stored, archived: true })
          .catch(ignoreMissing);
      return link.client
        .call("session.delete", { session_id: stored })
        .catch(ignoreMissing);
    },
    // Hermes's own maintenance never archives an AgentPier session (its reaper only
    // lets idle live sessions go, which a later call resumes); an archived one is
    // restored with its history.
    async keepOpen({ key }) {
      const link = await reach();
      const stored = storedIdOf(link.agentId, key);
      const row = stored && (await storedRow(link, stored));
      if (!row && !link.runs.sidOf(key)) return "missing";
      await link.client
        .call("session.archive", { session_id: stored, archived: false })
        .catch((error) => {
          if (!(error?.answered && notFound.has(error.hermesCode))) throw error;
        });
      return "open";
    },
    // Hermes refuses no turn of an archived session, so no refused turn goes again.
    reopenRefused: async () => false,
    async compact({ key, timeoutMs }) {
      const link = await reach();
      return onLive(link, key, "session.compress", {}, { timeoutMs });
    },
    // A live session's events reach every attached client: resuming it here is the
    // subscription.
    async subscribeMessages({ key }) {
      const link = await reach();
      await live(link, key);
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
