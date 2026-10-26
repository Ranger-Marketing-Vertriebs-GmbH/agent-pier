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
async function setup(t, { granted = true, shell = "full" } = {}) {
  const f = hookFixture(t);
  f.store.updateAssistant(f.id, { shell }, f.store.getAssistant(f.id).revision);
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
  // The tool guard's question for a session (bridge-tool-policies.js).
  const reads = (sessionKey) =>
    f.hooks.secretsRead({ agentId: f.runtimeAgentId, sessionKey }).allow;
  const session = (running) => `agent:${f.runtimeAgentId}:cron:${running.jobId}:run:r1`;
  return { ...f, secrets, file, present, atRun, synced, reads, session };
}

test("a hook run with a shell and without Secrets runs while the file is withheld", async (t) => {
  const f = await setup(t);
  const hook = makeHook(f, { rights: { shell: "full" } });
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

test("coding and MCP reach past the file-tool guard as the shell does", async (t) => {
  const f = await setup(t, { shell: "off" });
  f.assistants.workflows.access.get().projectIds = ["p1"];
  const hook = makeHook(f, { rights: { coding: true } });
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.equal(event(f, hook, "p1").secretsWithheld, true);
  assert.deepEqual(f.atRun, [false]);
});

test("a hook run without a shell keeps the file for other chats and reads none of it", async (t) => {
  const f = await setup(t, { shell: "off" });
  const hook = makeHook(f, { rights: { memory: false } });
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  assert.equal(running.status, "running");
  assert.equal(running.secretsRead, false);
  assert.equal(running.secretsWithheld, undefined);
  // The file stays for the agent's other chats.
  assert.deepEqual(f.atRun, [true]);
  assert.equal(f.hooks.withholdsSecrets(f.id), false);
  await f.secrets.sync(f.id);
  assert.equal(f.present(), true);
  // The run's own file-tool reads of it are refused, every other session reads.
  assert.equal(f.reads(f.session(running)), false);
  assert.equal(f.reads(`agent:${f.runtimeAgentId}:main`), true);
  assert.equal(f.reads(`agent:${f.runtimeAgentId}:cron:routine-job`), true);
  assert.equal(f.reads(undefined), true);
  // A forged agent id for the hook's session reads nothing either.
  assert.equal(
    f.hooks.secretsRead({ agentId: "ap-other", sessionKey: f.session(running) }).allow,
    false,
  );
  // The run is told so, since the agent's instructions name the file.
  const add = f.calls.find((c) => c.method === "cron.add");
  assert.match(add.input.payload.message, /secrets are not available in this run/);
  await f.hooks.runs.complete(running.id, done(running.jobId));
  assert.equal(f.reads(f.session(running)), false);
});

test("a hook run with Secrets reads the agent's secrets file", async (t) => {
  const f = await setup(t);
  const hook = makeHook(f, { rights: { secrets: true, shell: "full" } });
  assert.equal(hook.rights.secrets, true);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.equal(event(f, hook, "p1").status, "running");
  assert.equal(event(f, hook, "p1").secretsWithheld, undefined);
  assert.deepEqual(f.atRun, [true]);
  assert.equal(f.hooks.withholdsSecrets(f.id), false);
  const running = event(f, hook, "p1");
  assert.equal(f.reads(f.session(running)), true);
  const add = f.calls.find((c) => c.method === "cron.add");
  assert.doesNotMatch(add.input.payload.message, /secrets are not available/);
  // Once settled, its session reads nothing.
  await f.hooks.runs.complete(running.id, done(running.jobId));
  assert.equal(f.reads(f.session(running)), false);
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
  const hook = makeHook(f, { rights: { shell: "full" } });
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
