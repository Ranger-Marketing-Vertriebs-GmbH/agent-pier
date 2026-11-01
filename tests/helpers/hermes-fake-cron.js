// The cron REST routes a Hermes messaging gateway hosts (v0.22.5
// hermes_cli/web_routers/cron.py), as the RPC bridge's `agentpier.http` reaches them,
// in memory for the fake gateway (hermes-fake-gateway.js). Jobs keep fields they do
// not know (update_job merges), a create may start paused, a forced run (`trigger`)
// resumes a paused job and answers once the run ended, and each run writes a stored
// session with the prompt and its echo, which session.history reads. Every change
// emits `cron.changed`.

const iso = (ms) => new Date(ms).toISOString();

function parse(schedule) {
  const text = String(schedule || "").trim();
  const every = /^every (\d+)m$/.exec(text);
  if (every) return { kind: "interval", minutes: Number(every[1]) };
  if (text.split(/\s+/).length === 5) return { kind: "cron", expr: text, display: text };
  if (Number.isFinite(Date.parse(text))) return { kind: "once", run_at: text };
  return null;
}

/** The cron store of a fake Hermes home, kept across its restarts. */
export const cronStore = () => ({ jobs: new Map(), runs: new Map(), created: 0 });

/**
 * Answers one `agentpier.http` call (`{ method, path, query, body }`) as `{ status,
 * body }` over `cron` (cronStore), the session store `rows` (hermesStore) and
 * `changed()`, called after each write. `now()` is the clock.
 */
export function cronRest(
  cron,
  rows,
  params,
  { changed = () => {}, now = Date.now } = {},
) {
  const { method, path, query = {}, body } = params;
  if (query.profile !== "default")
    return { status: 403, body: { detail: "profile_scope_mismatch" } };
  const answer = (status, value) => ({ status, body: value });
  const parts =
    /^\/api\/cron\/jobs(?:\/([^/]+))?(?:\/(pause|resume|trigger|runs))?$/.exec(path);
  if (!parts) return answer(404, { detail: "Not Found" });
  const [, id, action] = parts;
  const write = (value) => {
    changed();
    return answer(200, value);
  };
  if (!id && method === "GET") return answer(200, [...cron.jobs.values()]);
  if (!id && method === "POST") {
    const schedule = parse(body?.schedule);
    if (!schedule || !body?.prompt) return answer(400, { detail: "invalid job" });
    const job = {
      id: `job${++cron.created}abc`,
      name: body.name || body.prompt.slice(0, 50),
      prompt: body.prompt.trim(),
      model: body.model ?? null,
      schedule,
      enabled: !body.paused,
      state: body.paused ? "paused" : "scheduled",
      next_run_at: body.paused ? null : iso(now() + 3600000),
      last_run_at: null,
      last_status: null,
      last_error: null,
      failure_streak: 0,
      deliver: body.deliver || "local",
      fire_claim: null,
    };
    cron.jobs.set(job.id, job);
    return write(job);
  }
  const job = cron.jobs.get(id);
  if (!job) return answer(404, { detail: "Job not found" });
  if (!action && method === "GET") return answer(200, job);
  if (!action && method === "DELETE") {
    cron.jobs.delete(id);
    return write({ ok: true });
  }
  if (!action && method === "PUT") {
    const updates = { ...body?.updates };
    if ("schedule" in updates) {
      updates.schedule = parse(updates.schedule);
      if (!updates.schedule) return answer(400, { detail: "invalid schedule" });
    }
    if ("prompt" in updates) updates.prompt = String(updates.prompt).trim();
    Object.assign(job, updates);
    return write(job);
  }
  if (action === "pause" || action === "resume") {
    Object.assign(job, {
      enabled: action === "resume",
      state: action === "resume" ? "scheduled" : "paused",
    });
    return write(job);
  }
  if (action === "trigger" && method === "POST") {
    const runs = cron.runs.get(id) || [];
    const started = now();
    const sid = `local-cron-${id}-${runs.length + 1}`;
    rows.set(sid, {
      id: sid,
      title: null,
      revision: 0,
      generation: 0,
      archived: false,
      messages: [
        { role: "user", text: job.prompt, row_id: 1 },
        { role: "assistant", text: `ECHO: ${job.prompt}`, row_id: 2 },
      ],
    });
    cron.runs.set(id, [
      {
        id: sid,
        source: "cron",
        started_at: started / 1000,
        ended_at: started / 1000 + 0.5,
      },
      ...runs,
    ]);
    Object.assign(job, {
      enabled: true,
      state: "scheduled",
      last_run_at: iso(started + 500),
      last_status: "ok",
    });
    return write(job);
  }
  if (action === "runs" && method === "GET")
    return answer(200, {
      runs: (cron.runs.get(id) || []).slice(0, Number(query.limit) || 20),
    });
  return answer(405, { detail: "Method Not Allowed" });
}
