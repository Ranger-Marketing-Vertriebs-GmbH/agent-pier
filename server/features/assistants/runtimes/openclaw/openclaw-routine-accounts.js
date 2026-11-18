import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// The inference account a routine runs on (OpenClaw 2026.11.3; docs/assistant-runtime-
// updates.md, "Routine inference accounts"). An agent-turn job that runs on a stored account (an
// AgentPier-held ChatGPT login is one: `openai/<model>@<profileId>`) must carry that
// account as its recorded `inferenceBinding`, or each run refuses with "Automation has
// no recorded inference account". OpenClaw records it when a job is created, and on a
// `cron.update` that selects `model@profile`; jobs from before 2026.11.3 carry none,
// and Doctor cannot adopt them for AgentPier (it withholds the provider keys and runs
// before AgentPier writes its logins). Configured provider keys need no account.
//
// Adoption here: a job whose recorded account is missing or is not its agent's selects
// the agent's account with `model@profile` and gets its own model choice back in a
// second update (the recorded account stays; a plain model change keeps it), so the
// job still follows the agent's model. A job that names `model@profile` itself keeps
// its choice. Idempotent: bound jobs are left alone.

const busyMs = 5000;
const text = (value) => (typeof value === "string" && value ? value : null);

/** `{ provider, model, profileId }` of a model reference or `{ primary }`; or null. */
export function modelAccount(ref) {
  const value = text(typeof ref === "string" ? ref : ref?.primary);
  if (!value) return null;
  // A profile id may itself hold "@" (an e-mail); a model never does.
  const at = value.indexOf("@");
  const model = at < 0 ? value : value.slice(0, at);
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  return {
    provider: model.slice(0, slash),
    model,
    profileId: at < 0 ? null : text(value.slice(at + 1)),
  };
}

/**
 * The recorded account of every job in OpenClaw's cron store (`state/openclaw.sqlite`,
 * opened read-only), job id → `{ provider, profileId }`; null when the store or its
 * layout is not there, which counts every job as unbound.
 */
export function readAccountBindings(stateDir) {
  const file = path.join(stateDir || "", "state", "openclaw.sqlite");
  if (!stateDir || !fs.existsSync(file)) return null;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec(`PRAGMA busy_timeout = ${busyMs}`);
    const rows = db
      .prepare(
        "SELECT job_id AS id, json_extract(job_json, '$.inferenceBinding.provider') AS provider, json_extract(job_json, '$.inferenceBinding.profileId') AS profileId FROM cron_jobs",
      )
      .all();
    return new Map(
      rows
        .filter((row) => text(row.profileId))
        .map((row) => [row.id, { provider: row.provider, profileId: row.profileId }]),
    );
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * The jobs (routines, routine-definition.js) that adopt an account: `{ id, agentId,
 * adopt, restore }`, `adopt` the `model@profile` to select, `restore` the job's own
 * model afterwards (null: the agent's; undefined: no second update). `agents` maps an
 * agent id to its model reference, `bindings` is readAccountBindings's answer.
 */
export function accountAdoptions({ jobs, agents, bindings }) {
  const adoptions = [];
  for (const job of jobs) {
    // An agent turn in its own or a chat's session; a main-session event runs none.
    if (!job?.prompt || job.target?.kind === "main" || !agents.has(job.agentId)) continue;
    const own = modelAccount(job.prompt.model);
    const agent = modelAccount(agents.get(job.agentId));
    let adopt, restore;
    if (own?.profileId) {
      adopt = job.prompt.model;
      restore = undefined;
    } else {
      // The job's provider must be the account's: another one runs on its key.
      if (!agent?.profileId || (own && own.provider !== agent.provider)) continue;
      adopt = `${own?.model ?? agent.model}@${agent.profileId}`;
      restore = own?.model ?? null;
    }
    const wanted = modelAccount(adopt).profileId;
    if (bindings && bindings.get(job.id)?.profileId === wanted) continue;
    adoptions.push({ id: job.id, agentId: job.agentId, adopt, restore });
  }
  return adoptions;
}

const modelPatch = (id, model) => ({
  id,
  patch: { payload: { kind: "agentTurn", model } },
});
const entryModels = (config) => {
  const entries = config?.agents?.entries;
  const list = Array.isArray(entries)
    ? entries.map((entry) => [entry?.id, entry?.model])
    : Object.entries(entries || {}).map(([id, entry]) => [id, entry?.model]);
  return new Map(list.filter(([id, model]) => text(id) && model));
};

/**
 * Adopts the accounts of every job (of `agentId` alone when given) through the Gateway
 * (`call`); `list` answers the routines (openclaw-routines.js). Resolves `{ adopted,
 * failed }`: job ids, and `{ id, agentId, message }` for a job OpenClaw refused (no
 * usable account: logged out, expired, another provider), whose runs keep failing
 * with the account reason (routine-failures.js) until its account is usable.
 */
export async function adoptRoutineAccounts({ call, list, stateDir, agentId }) {
  const { config } = (await call("config.get", {})) || {};
  const agents = entryModels(config);
  const jobs = (await list({ agentId })).filter(
    (j) => !agentId || j?.agentId === agentId,
  );
  const adoptions = accountAdoptions({
    jobs,
    agents,
    bindings: readAccountBindings(stateDir),
  });
  const adopted = [];
  const failed = [];
  for (const { id, agentId: owner, adopt, restore } of adoptions)
    try {
      await call("cron.update", modelPatch(id, adopt));
      if (restore !== undefined) await call("cron.update", modelPatch(id, restore));
      adopted.push(id);
    } catch (error) {
      failed.push({ id, agentId: owner, message: String(error?.message || error) });
    }
  return { adopted, failed };
}
