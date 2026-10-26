import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  body,
  done,
  event,
  hookFixture,
  makeHook,
  settle,
} from "../helpers/agent-hook-fixture.js";
import { AgentSecrets } from "../../server/features/secrets/agent-secrets.js";

// The hook fixture with one granted secret delivered to the agent's workspace as
// AgentPier delivers it (agent-secrets.js), wired as connectAgentSecrets wires it.
// `present` tells whether the file is on disk; `atRun` records it at each cron.run.
async function setup(t, { granted = true } = {}) {
  const f = hookFixture(t);
  const access = {
    projectIds: [],
    sshAccesses: [],
    ...(granted ? { secretIds: ["s1"] } : {}),
  };
  f.assistants.workflows.access = {
    s: {},
    get: () => access,
    sshHosts: () => [],
    secretIds: () => access.secretIds || [],
  };
  const workspaces = path.join(f.dataDir, "workspaces");
  fs.mkdirSync(path.join(workspaces, f.id), { recursive: true });
  const secrets = new AgentSecrets({
    store: { entries: (ids) => ids.map(() => ({ name: "ZABBIX_TOKEN", value: "t0k" })) },
    access: f.assistants.workflows.access,
    assistants: f.assistants,
    workspaces,
  });
  f.assistants.config.syncSecrets = (id) => secrets.sync(id);
  const file = secrets.file(f.id);
  const present = () => fs.existsSync(file);
  const atRun = [];
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.run") atRun.push(present());
    return call(method, input);
  };
  await secrets.sync(f.id);
  assert.equal(present(), granted);
  // Waits for the syncs a settled event queued.
  const synced = async () => {
    await settle();
    await secrets.queue;
  };
  return { ...f, secrets, file, present, atRun, synced };
}

test("a hook run without Secrets runs while the agent's secrets file is withheld", async (t) => {
  const f = await setup(t);
  const hook = makeHook(f, { rights: { shell: "off" } });
  assert.equal(hook.rights.secrets, false);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  assert.equal(running.status, "running");
  assert.equal(running.secretsWithheld, true);
  assert.deepEqual(f.atRun, [false]);
  // A turn of the agent meanwhile (each turn syncs first) does not bring it back.
  await f.secrets.sync(f.id);
  assert.equal(f.present(), false);
  assert.equal(f.hooks.withholdsSecrets(f.id), true);
  // Once the event settles, the file is back.
  await f.hooks.runs.complete(running.id, done(running.jobId));
  await f.synced();
  assert.equal(f.hooks.withholdsSecrets(f.id), false);
  assert.equal(f.present(), true);
});

test("a hook run with Secrets reads the agent's secrets file", async (t) => {
  const f = await setup(t);
  const hook = makeHook(f, { rights: { secrets: true } });
  assert.equal(hook.rights.secrets, true);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.equal(event(f, hook, "p1").status, "running");
  assert.equal(event(f, hook, "p1").secretsWithheld, undefined);
  assert.deepEqual(f.atRun, [true]);
  assert.equal(f.hooks.withholdsSecrets(f.id), false);
});

test("Secrets the agent no longer receives cannot be switched on", async (t) => {
  const f = await setup(t, { granted: false });
  assert.throws(() => makeHook(f, { rights: { secrets: true } }), {
    status: 400,
    key: "hookRightExceeds",
  });
});

test("an event that fails or cannot withhold the file gives it back", async (t) => {
  const f = await setup(t);
  const hook = makeHook(f);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.equal(f.present(), false);
  // A lost completion: the sweep fails the event.
  f.hooks.runs.fail(event(f, hook, "p1"));
  await f.synced();
  assert.equal(f.present(), true);
  // The file cannot be withheld: the run never starts.
  const sync = f.assistants.config.syncSecrets;
  f.assistants.config.syncSecrets = async () => {
    throw new Error("disk");
  };
  const refused = await f.hooks.deliver(hook, body('{"id":"p2"}'));
  assert.equal(refused.status, 503);
  assert.equal(event(f, hook, "p2"), null);
  assert.equal(f.atRun.length, 1);
  assert.equal(f.hooks.withholdsSecrets(f.id), false);
  f.assistants.config.syncSecrets = sync;
  await f.synced();
  assert.equal(f.present(), true);
});
