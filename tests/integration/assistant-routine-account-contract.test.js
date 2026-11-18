import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import { runtimeFor } from "../../server/features/assistants/runtimes/runtime-for.js";
import { readAccountBindings } from "../../server/features/assistants/runtimes/openclaw/openclaw-routine-accounts.js";
import { runFailure } from "../../server/features/assistants/routine-failures.js";
import { fakeAccess } from "../helpers/fake-chatgpt.js";

// OpenClaw 2026.11.3 refuses every run of an agent-turn job on a stored account
// (an AgentPier-held ChatGPT login) that carries no recorded inference account. The
// fixture contracts run on a configured provider key, which needs none, so they
// never saw it. Synthetic tokens only, and nothing leaves the host: the proxy
// variables point at a closed local port, so a run that passes the account check
// ends at the model request instead.
const installed = process.env.AGENTPIER_ASSISTANT_PROVIDER_RUNTIME;
const profileId = "openai:routine-account@example.invalid";
const model = "openai/gpt-5.6-terra";

function closedProxy(t) {
  const proxies = ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"];
  const names = [...proxies, "NO_PROXY", "no_proxy"];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  for (const name of names) delete process.env[name];
  for (const name of proxies) process.env[name] = "http://127.0.0.1:9";
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
}

// Drops a job's recorded account from OpenClaw's cron store while its Gateway is
// stopped, as a job created before 2026.11.3 is stored.
function unrecord(stateDir, id) {
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
  try {
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.inferenceBinding') WHERE job_id = ?",
    ).run(id);
  } finally {
    db.close();
  }
}

test(
  "routines run on an AgentPier-held ChatGPT account: new ones at once, old ones after adoption",
  { skip: !installed, timeout: contractTimeout(400000) },
  async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-routine-account-"));
    const app = path.join(installed, "app/node_modules/openclaw");
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => ({
        version: runtimeManifest.version,
        nodePath: path.join(installed, "node/bin/node"),
        entryPath: path.join(app, "openclaw.mjs"),
      }),
    });
    closedProxy(t);
    t.after(async () => {
      try {
        await runtime.stop();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    });
    await runtime.start();
    const { models, agents, routines } = runtimeFor(null, runtime);
    const identity = { accountId: "acct", email: "routine-account@example.invalid" };
    const login = (expires = Date.now() + 3 * 3600_000) =>
      models.writeAccess({
        profileId,
        credential: {
          access: fakeAccess({ ...identity, expires }),
          expires,
          ...identity,
        },
      });
    const bindings = () => readAccountBindings(runtime.paths.state);
    // The cause of a forced run's failure ("ok" for none), once it finished.
    const ran = async (id) => {
      const since = Date.now() - 1;
      await routines.run({ id, force: true });
      for (let i = 0; i < 120; i++) {
        const { entries } = await routines.runs({ id, limit: 5 });
        const entry = entries.find((e) => e.runAtMs > since && e.status);
        if (entry) return runFailure(entry) ?? { reason: "ok" };
        await delay(500);
      }
      assert.fail(`no run of ${id}`);
    };
    const routine = (name) => ({
      name,
      agentId,
      enabled: false,
      schedule: { kind: "cron", expression: "0 9 * * *" },
      target: { kind: "own" },
      prompt: { text: `ROUTINE_ACCOUNT_CONTRACT ${name}`, tools: [] },
      delivery: { kind: "none" },
    });

    // An agent on an AgentPier-held ChatGPT login (AssistantConfig.apply).
    await login();
    const workspace = path.join(dataDir, "workspace");
    fs.mkdirSync(workspace);
    const { agentId } = await agents.create({
      name: "ap-account",
      workspace,
      model: `${model}@${profileId}`,
    });
    await agents.waitListed({ agentId });
    // A routine AgentPier creates records the account itself.
    const fresh = await routines.add({ routine: routine("fresh") });
    assert.equal(bindings().get(fresh.id)?.profileId, profileId);
    // A job as 2026.11.2 left it, which Doctor did not adopt: no account recorded.
    const old = await routines.add({ routine: routine("old") });
    await runtime.stop();
    unrecord(runtime.paths.state, old.id);
    await runtime.start();
    assert.equal(bindings().has(old.id), false, "readable store, nothing recorded");
    const refused = await ran(old.id);
    t.diagnostic(`unbound run=${JSON.stringify(refused)}`);
    assert.equal(refused.reason, "account");
    assert.match(refused.message, /no recorded inference account/);

    // The repair after the Gateway is ready: the job adopts the agent's account and
    // follows the agent's model again; its prompt and tools stay.
    const repair = await routines.adoptAccounts();
    assert.deepEqual(repair, { adopted: [old.id], failed: [] });
    assert.equal(bindings().get(old.id)?.profileId, profileId);
    const [adopted] = (await routines.list({ agentId })).filter((r) => r.id === old.id);
    assert.equal(adopted.prompt.model, undefined);
    assert.equal(adopted.prompt.text, "ROUTINE_ACCOUNT_CONTRACT old");
    assert.deepEqual(adopted.prompt.tools, []);
    const repaired = await ran(old.id);
    t.diagnostic(`adopted run=${JSON.stringify(repaired)}`);
    assert.notEqual(repaired.reason, "account");

    // A renewed token (AgentPier's vault) keeps the recorded account usable.
    await login(Date.now() + 4 * 3600_000);
    const renewed = await ran(fresh.id);
    t.diagnostic(`fresh run=${JSON.stringify(renewed)}`);
    assert.notEqual(renewed.reason, "account");
    // Idempotent: nothing left to adopt.
    assert.deepEqual(await routines.adoptAccounts(), { adopted: [], failed: [] });
  },
);
