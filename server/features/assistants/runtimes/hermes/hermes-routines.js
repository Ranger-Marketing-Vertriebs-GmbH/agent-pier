import path from "node:path";
import { readJSON, writePrivate } from "../../../../lib/storage.js";
import { webhookToken } from "../../reminder-webhook.js";
import { assistantProblem } from "../../assistant-validation.js";
import { boundPort, reachable, stateOf } from "./hermes-connection.js";
import { hermesError } from "./hermes-rpc-client.js";
import { storedIdOf } from "./hermes-run-state.js";
import { processZone } from "./hermes-cron-zone.js";
import {
  hermesCreate,
  hermesCronRunOf,
  hermesUpdates,
  metaField,
  repinOf,
  routineMeta,
  routineOfJob,
  routineRun,
  runSessionKey,
} from "./hermes-routine-jobs.js";

// The gateway serves its own home as the profile "default" (hermes_cli/profiles.py:
// a custom HERMES_HOME is the default root); its REST routes refuse a native ticket
// that names no profile (dashboard_auth/native_http.py).
const profile = "default";
// A forced run answers once it ended (web_routers/cron.py _trigger_cron_job_sync); a
// run still going after this long is under way, which is all run() reports.
const triggerSeconds = 15;
const callSeconds = 30;
// Hermes's silent token (cron/scheduler_prompt.py) and AgentPier's.
const silentToken = "[SILENT]";
const agentPierSilent = "NO_REPLY";
// The zone Hermes runs cron expressions in: the agent's processes share this one's
// TZ (hermes-environment.js); a function, so it is read at each call.
const zoneOf = (zone) => (typeof zone === "function" ? zone() : zone) || processZone();

const refusal = (code, status, body) =>
  Object.assign(hermesError(code), {
    answered: true,
    httpStatus: status,
    ...(typeof body?.detail === "string" && { remoteMessage: body.detail.slice(0, 300) }),
  });

// An HTTP answer as the port's errors: a refusal Hermes answered, or unreachable.
function answerOf({ status, body, timedOut } = {}, { pending = false } = {}) {
  if (timedOut) {
    if (pending) return { pending: true };
    throw hermesError("TIMEOUT");
  }
  if (status >= 200 && status < 300) return { body };
  if (status === 404) throw refusal("NOT_FOUND", status, body);
  if (status === 400 || status === 422) throw refusal("INVALID_REQUEST", status, body);
  if (status === 409) throw refusal("CONFLICT", status, body);
  if (status === 401 || status === 403) throw refusal("FORBIDDEN", status, body);
  throw hermesError("RPC_FAILED");
}

/**
 * One call of the gateway's REST API through the RPC bridge (`agentpier.http`,
 * hermes-rpc-bridge.py), which takes a one-request ticket from the gateway's control
 * socket for it. Resolves `{ body }`, or `{ pending }` for a call still running after
 * `seconds` when `pending` allows it.
 */
export async function hermesRest(client, method, route, options = {}) {
  const { query = {}, body, seconds = callSeconds, pending = false } = options;
  const answer = await client.call(
    "agentpier.http",
    {
      method,
      path: route,
      query: { profile, ...query },
      ...(body !== undefined && { body }),
      timeout: seconds,
    },
    { timeoutMs: (seconds + 15) * 1000 },
  );
  return answerOf(answer, { pending });
}

const jobPath = (id) => {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
    throw refusal("NOT_FOUND", 404);
  return `/api/cron/jobs/${id}`;
};

// The jobs of the gateway's home; a listing that is no list is unavailable.
async function listJobs(client) {
  const { body } = await hermesRest(client, "GET", "/api/cron/jobs");
  if (!Array.isArray(body)) throw assistantProblem("unavailable", 503);
  return body;
}

/**
 * The routines sub-port (agent-runtime.js) over the cron scheduler of the agent's
 * messaging gateway: the REST routes it hosts (`/api/cron/jobs…`), reached through
 * the RPC bridge. Each routine is one Hermes job (hermes-routine-jobs.js); the gateway
 * serves one agent, so a routine of another agent is refused. A job is created paused,
 * given AgentPier's meta and only then resumed, so it never runs without it. Hermes's
 * forced run (`trigger`) also resumes a paused job; a routine that was disabled is
 * paused again after it. Results reach AgentPier through HermesRoutineDeliveries.
 */
export const hermesRoutines = (supervisor, { deliveries, zone } = {}) =>
  boundPort((current) => routinesOver(current, supervisor, deliveries, zone), supervisor);

/**
 * Pins a job of a routine in its own time zone to its next occurrence when its pin
 * passed or names another (repinOf); answers the job as it is then.
 */
export async function repinned(client, job, { zone, now = Date.now() } = {}) {
  const pin = repinOf(job, { zone: zoneOf(zone), now });
  if (!pin) return job;
  return (
    await hermesRest(client, "PUT", jobPath(job.id), {
      body: { updates: { schedule: pin } },
    })
  ).body;
}

function routinesOver(current, supervisor, deliveries, zone) {
  const agentId = supervisor.agentId;
  const timing = () => ({ zone: zoneOf(zone), now: Date.now() });
  const link = async () => reachable(current());
  const own = (routine) => {
    if (routine.agentId !== undefined && routine.agentId !== agentId)
      throw refusal("INVALID_REQUEST", 400);
  };
  const read = (job) =>
    routineOfJob(job, { agentId, delivered: deliveries?.statusOf(job?.id, job) });
  const get = async (client, id) => (await hermesRest(client, "GET", jobPath(id))).body;
  const toggle = async (client, id, enabled) =>
    (await hermesRest(client, "POST", `${jobPath(id)}/${enabled ? "resume" : "pause"}`))
      .body;
  return {
    async list({ agentId: wanted } = {}) {
      const { client } = await link();
      const jobs = await listJobs(client);
      if (wanted && wanted !== agentId) return [];
      return jobs.map(read).filter(Boolean);
    },
    async add({ routine }) {
      const { client } = await link();
      own(routine);
      const create = hermesCreate(routine, timing());
      const { body: created } = await hermesRest(client, "POST", "/api/cron/jobs", {
        body: create,
      });
      if (typeof created?.id !== "string") throw hermesError("RPC_FAILED");
      const meta = routineMeta({ agentId, ...routine });
      let job = (
        await hermesRest(client, "PUT", jobPath(created.id), {
          body: { updates: { [metaField]: meta } },
        })
      ).body;
      if (routine.enabled !== false) job = await toggle(client, created.id, true);
      return read(job);
    },
    async update({ id, patch }) {
      const { client } = await link();
      own(patch);
      const old = await get(client, id);
      const meta = routineMeta(patch, old?.[metaField] || {});
      let job = (
        await hermesRest(client, "PUT", jobPath(id), {
          body: { updates: hermesUpdates(patch, meta, timing()) },
        })
      ).body;
      if (typeof patch.enabled === "boolean" && patch.enabled !== job?.enabled)
        job = await toggle(client, id, patch.enabled);
      // A pin that passed while the job was paused moves to the next occurrence.
      return read(await repinned(client, job, { zone }));
    },
    async remove({ id }) {
      const { client } = await link();
      await hermesRest(client, "DELETE", jobPath(id));
      deliveries?.forget(id);
      return { removed: true };
    },
    async run({ id, force = false }) {
      const { client } = await link();
      const job = await get(client, id);
      if (!job.enabled && !force) return { queued: false, refused: true };
      try {
        await hermesRest(client, "POST", `${jobPath(id)}/trigger`, {
          seconds: triggerSeconds,
          pending: true,
        });
      } catch (error) {
        // Running already, or claimed by the scheduler meanwhile.
        if (error.code === "CONFLICT") return { queued: false, refused: true };
        throw error;
      } finally {
        if (!job.enabled) await toggle(client, id, false).catch(() => {});
      }
      deliveries?.check();
      return { queued: true, refused: false };
    },
    async runs({ id, limit = 20 }) {
      const { client } = await link();
      const job = await get(client, id);
      const { body } = await hermesRest(client, "GET", `${jobPath(id)}/runs`, {
        query: { limit: Math.max(1, Math.min(100, limit)) },
      });
      const rows = Array.isArray(body?.runs) ? body.runs : [];
      const latest = read(job)?.runState?.lastStatus;
      return {
        entries: rows.map((row, index) =>
          routineRun(row, { agentId, jobId: id, last: index === 0 ? latest : undefined }),
        ),
      };
    },
    // The gateway ticks its cron store whenever it runs: a listing proves it.
    async status() {
      const { client } = await link();
      await listJobs(client);
      return { enabled: true };
    },
    runOf: (sessionKey) => hermesCronRunOf(sessionKey),
  };
}

// The text a finished run delivers: the last reply of its newest run session.
async function runText(client, agentId, job) {
  const { body } = await hermesRest(client, "GET", `${jobPath(job.id)}/runs`, {
    query: { limit: 1 },
  });
  const row = Array.isArray(body?.runs) ? body.runs[0] : null;
  if (typeof row?.id !== "string" || row.id.startsWith("cron_output:"))
    return { text: "", sessionKey: undefined };
  const history = await client.call("session.history", { session_id: row.id });
  const reply = (history?.messages || [])
    .filter((m) => m?.role === "assistant" && typeof m.text === "string")
    .at(-1)?.text;
  const text = reply?.trim() === silentToken ? agentPierSilent : (reply ?? "");
  return { text, sessionKey: runSessionKey(agentId, job.id, row.id) };
}

/**
 * Delivers the results of the agent's routine runs to AgentPier, as OpenClaw's
 * completion webhook does: Hermes keeps a run's result (delivery `local`), so after
 * each run of a job whose routine delivers to AgentPier (`chat`, `webhook`) this posts
 * `{ jobId, runAtMs, status, summary, error, deliveryStatus, sessionKey }` to the
 * routine's URL with the webhook's token (reminder-webhook.js). A run is found by its
 * job's `last_run_at`, checked on every `cron.changed` event the gateway sends, after
 * each forced run and every `intervalMs`; what was delivered is kept in `file`, so a
 * restart of either side delivers each run once more at most. A run whose routine
 * delivers into a chat (`chat` delivery to a `chat` target) is also written into that
 * session's history as a note (`agentpier.note`, hermes-rpc-bridge.py), so the agent's
 * later turns see it as OpenClaw's do; the note is no reply of the chat
 * (`deliveryStatus` "not-delivered"), so AgentPier shows the result beside it; while a
 * turn of that chat runs, the note waits for its end (chatBusy). Each pass
 * also pins the jobs of routines in their own time zone to their next occurrence
 * (repinOf), in `zone`, the zone Hermes runs them in.
 */
// The gateway events after which a pass runs: a cron change, and the end of a turn
// whose chat a note may wait for.
const turnEnds = new Set(["cron.changed", "message.complete", "error"]);

/**
 * Whether a turn of the chat `key` names is under way or queued on `client`'s
 * connection (hermes-run-state.js): Hermes writes a turn's reply rows when the turn
 * ends, so a note written meanwhile would stand before that reply in the history.
 */
export function chatBusy(client, key) {
  const runs = stateOf(client)?.runs;
  const sid = typeof key === "string" ? runs?.sidOf(key) : null;
  const turn = sid ? runs.turns.get(sid) : null;
  return !!turn && (turn.current !== null || turn.open.size > 0 || turn.queue.length > 0);
}

export class HermesRoutineDeliveries {
  constructor({
    supervisor,
    file,
    token = () => null,
    post = fetch,
    intervalMs = 15000,
    timers = globalThis,
    zone,
  }) {
    Object.assign(this, { supervisor, file, token, post, intervalMs, timers, zone });
    this.client = null;
    this.timer = null;
    this.running = null;
    this.again = false;
    // Runs (`<job>@<last_run_at>`) whose note this process wrote: a retried webhook
    // writes it once.
    this.notedRuns = new Set();
    // A turn's end may free a note that waited for it (busy).
    this.onEvent = (params) => turnEnds.has(params?.type) && this.check();
  }

  records() {
    if (!this.file) return (this.memory ||= {});
    const saved = readJSON(this.file, {});
    return saved && typeof saved === "object" ? saved : {};
  }

  save(records) {
    if (!this.file) this.memory = records;
    else writePrivate(this.file, records);
  }

  /** The delivery status of a job's last run, while it is the run delivered. */
  statusOf(id, job) {
    const record = typeof id === "string" ? this.records()[id] : null;
    return record && record.lastRunAt === job?.last_run_at ? record.status : undefined;
  }

  forget(id) {
    const records = this.records();
    if (!records[id]) return;
    delete records[id];
    this.save(records);
  }

  /** Follows the supervisor's current client: the client that became ready, or none. */
  follow(client) {
    if (client === this.client) return;
    this.client?.off("event", this.onEvent);
    this.timers.clearInterval(this.timer);
    this.timer = null;
    this.client = client || null;
    if (!this.client) return;
    this.client.on("event", this.onEvent);
    this.timer = this.timers.setInterval(() => this.check(), this.intervalMs);
    this.timer.unref?.();
    this.check();
  }

  close() {
    this.follow(null);
  }

  /** Checks for finished runs; one check at a time, one more after it when asked. */
  check() {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.pass()
      .catch(() => {})
      .finally(() => {
        this.running = null;
        if (this.again) {
          this.again = false;
          this.check();
        }
      });
    return this.running;
  }

  async pass() {
    const client = this.client;
    if (!client?.ready) return;
    const jobs = await listJobs(client);
    const records = this.records();
    let changed = false;
    for (const id of Object.keys(records))
      if (!jobs.some((job) => job.id === id)) {
        delete records[id];
        changed = true;
      }
    for (const job of jobs) {
      // One job's failure leaves the others' pins and deliveries going.
      await repinned(client, job, { zone: this.zone }).catch(() => {});
      const url = job[metaField]?.delivery?.url;
      if (typeof url !== "string" || !job.last_run_at) continue;
      const record = records[job.id];
      if (record?.lastRunAt === job.last_run_at) {
        // A note that could not be written yet is tried again while its run is the last.
        if (record.note && !record.noted && (await this.note(client, record.note))) {
          records[job.id] = {
            lastRunAt: record.lastRunAt,
            status: record.status,
            noted: true,
          };
          changed = true;
        }
        continue;
      }
      const delivered = await this.deliver(client, job, url).catch(() => null);
      if (!delivered) continue;
      records[job.id] = { lastRunAt: job.last_run_at, ...delivered };
      changed = true;
    }
    if (changed) this.save(records);
  }

  // The note of a run in its target chat's history (`{ session, text }`), or null
  // for a run whose routine does not deliver into a chat or that has nothing to say.
  noteOf(job, text) {
    const meta = job[metaField] || {};
    if (meta.delivery?.kind !== "chat" || meta.target?.kind !== "chat") return null;
    const session = storedIdOf(this.supervisor.agentId, meta.target.sessionKey);
    if (!session || !text.trim() || text.trim() === agentPierSilent) return null;
    // The label Hermes gives a cron delivery it mirrors into a chat.
    return {
      session,
      key: meta.target.sessionKey,
      text: `[Cron delivery: ${job.name || job.id}]\n${text.trim()}`,
    };
  }

  // Writes a note; whether it is done (written, or its session is gone). A note for a
  // chat whose turn runs waits for that turn's end (chatBusy): it is kept with its
  // run and written by a later pass, after the turn's reply.
  async note(client, note) {
    if (chatBusy(client, note.key)) return false;
    try {
      const answer = await client.call(
        "agentpier.note",
        { session_id: note.session, text: note.text.slice(0, 65536) },
        { timeoutMs: callSeconds * 1000 },
      );
      return answer?.appended === true || answer?.reason === "not_found";
    } catch {
      return false;
    }
  }

  // Posts one run's completion after writing its note; `{ status, note, noted }`
  // (the note kept while it is still to be written), or null to try again later.
  async deliver(client, job, url) {
    const agentId = this.supervisor.agentId;
    const ok = ["ok", "delivery_failed"].includes(job.last_status);
    // A failed run's session may be missing; a successful one's text is needed.
    const { text, sessionKey } = ok
      ? await runText(client, agentId, job)
      : await runText(client, agentId, job).catch(() => ({}));
    if (client !== this.client) return null;
    const event = {
      action: "finished",
      jobId: job.id,
      runAtMs: Math.round(Date.parse(job.last_run_at)),
      status: ok ? "ok" : "error",
      ...(ok ? { summary: text } : { error: job.last_error || job.last_status || "" }),
      deliveryStatus: "not-delivered",
      ...(sessionKey && { sessionKey }),
    };
    if (!Number.isSafeInteger(event.runAtMs)) return { status: "unknown" };
    const token = this.token();
    if (!token) return null;
    // In the chat's history before AgentPier learns of it: a turn the owner sends
    // after the result appeared sees it.
    const run = `${job.id}@${job.last_run_at}`;
    const note = ok && !this.notedRuns.has(run) ? this.noteOf(job, text) : null;
    const noted = note ? await this.note(client, note) : true;
    if (note && noted) this.notedRuns.add(run);
    const kept = noted ? {} : { note, noted: false };
    try {
      const response = await this.post(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(20000),
      });
      // AgentPier answers 204; a refusal of this event never changes on a retry.
      if (response.ok) return { status: "delivered", ...kept };
      return [408, 429].includes(response.status) || response.status >= 500
        ? null
        : { status: "rejected", ...kept };
    } catch {
      return null;
    }
  }
}

/** The deliveries of one agent's process set, kept beside its HERMES_HOME. */
export function hermesDeliveries(supervisor, { dataDir, ...options } = {}) {
  let file = null;
  try {
    file = path.join(supervisor.agentPaths().hermesHome, "agentpier-routine-runs.json");
  } catch {
    /* A supervisor without folders (a test double) keeps them in memory. */
  }
  return new HermesRoutineDeliveries({
    supervisor,
    file,
    token: () => (dataDir ? webhookToken(dataDir) : null),
    ...options,
  });
}
