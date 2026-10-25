import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { AgentHooks } from "../../server/features/assistants/agent-hooks.js";
import { secretMatches } from "../../server/features/assistants/agent-hook-store.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const base = { name: "Zabbix", sender: "zabbix01" };

// routineFixture (an agent with reminders on and a paired Telegram chat), a
// workflows stub whose grants a test sets in `f.grants`, and the hook service.
// Audits pass the real schema, so `f.audits` holds what the log would keep.
function hookFixture(t, options) {
  const f = routineFixture(t, options);
  const audits = [];
  const grants = {
    access: { projectIds: [], sshAccesses: [] },
    hosts: [],
    folders: {},
  };
  f.assistants.audit = { append: (event) => audits.push(auditEvent(event)) };
  f.assistants.workflows = {
    access: { get: () => grants.access, sshHosts: () => grants.hosts },
    folders: { ownAndShared: () => ({ ...grants.folders }) },
  };
  const hooks = new AgentHooks({
    reminders: f.reminders,
    routines: f.routines,
    notifications: { notify: async () => {} },
    addresses: (id) => ({ local: `http://127.0.0.1:4380/hooks/${id}` }),
  });
  return { ...f, hooks, audits, grants };
}
// Replaces the stored agent: the store has no setter for these lifecycle fields.
function rewrite(f, body) {
  f.store.db
    .prepare("UPDATE assistants SET body=? WHERE id=?")
    .run(JSON.stringify(body), f.id);
}

test("the owner creates a hook and sees its secret exactly once", async (t) => {
  const f = hookFixture(t);
  const { hook, secret } = await f.hooks.create(f.id, base);
  assert.match(secret, /^aph_/);
  assert.equal(hook.secretSet, true);
  assert.equal(hook.hourlyLimit, 20);
  assert.equal(hook.enabled, true);
  assert.equal(hook.active, true);
  assert.equal(hook.createdBy, "owner");
  assert.equal(hook.addresses.local, `http://127.0.0.1:4380/hooks/${hook.id}`);
  assert.equal(hook.lastEvent, null);
  assert.equal("secretHash" in hook, false);
  const listed = JSON.stringify(f.hooks.list(f.id));
  assert.equal(listed.includes(secret), false);
  assert.equal(listed.includes(f.hooks.store.get(hook.id).secretHash), false);
  assert.deepEqual(f.audits.at(-1).details, {
    kind: "hook",
    hookId: hook.id,
    change: "create",
    rights: [],
  });
});

test("the list carries the agent's ceiling and shell choices before any hook exists", (t) => {
  const f = hookFixture(t);
  f.grants.access = {
    projectIds: ["p1"],
    sshAccesses: [
      { accessId: "h1", mode: "routines" },
      { accessId: "h2", mode: "approval" },
      { accessId: "gone", mode: "routines" },
    ],
  };
  f.grants.hosts = [{ id: "h1" }, { id: "h2" }];
  f.grants.folders = { p1: "write" };
  const { hooks, ceiling, shellChoices } = f.hooks.list(f.id);
  assert.deepEqual(hooks, []);
  assert.deepEqual(ceiling, {
    telegram: true,
    research: false,
    webSearch: false,
    webFetch: false,
    coding: true,
    shell: "off",
    sshHosts: ["h1"],
    folders: { p1: "write" },
    memory: false,
    mcp: false,
  });
  assert.deepEqual(shellChoices, ["off"]);
});

test("an agent proposal creates a hook without a secret and audits its actor", async (t) => {
  const f = hookFixture(t);
  const result = await f.hooks.create(
    f.id,
    { ...base, instruction: "Restart the service.", hourlyLimit: 5 },
    { actor: "assistant", proposalId: "proposal-1" },
  );
  assert.equal("secret" in result, false);
  assert.equal(result.hook.secretSet, false);
  assert.equal(result.hook.secretSetAt, null);
  assert.equal(result.hook.createdBy, "assistant");
  assert.equal(result.hook.hourlyLimit, 5);
  assert.deepEqual(f.audits.at(-1).details, {
    kind: "hook",
    hookId: result.hook.id,
    change: "create",
    rights: [],
    actor: "assistant",
  });
});

test("hooks refuse shared, user, temporary and archived agents", async (t) => {
  const f = hookFixture(t);
  const { hook } = await f.hooks.create(f.id, base);
  const stored = f.store.storedAssistant(f.id);
  for (const fields of [
    { userAccess: { mode: "shared", members: [], released: [] } },
    { userAccess: { mode: "own", members: [], released: [] } },
    { teamMemberId: f.id, parentAssistantId: "lead", lifetime: "task" },
    { archivedAt: new Date().toISOString() },
  ]) {
    rewrite(f, { ...stored, ...fields });
    for (const call of [
      () => f.hooks.create(f.id, base),
      () => f.hooks.list(f.id),
      () => f.hooks.update(f.id, hook.id, { revision: hook.revision, name: "New" }),
      () => f.hooks.secret(f.id, hook.id, { revision: hook.revision }),
      () => f.hooks.remove(f.id, hook.id),
    ])
      assert.throws(
        call,
        { status: 403, key: "hookUnavailable" },
        JSON.stringify(fields),
      );
  }
  // Reminders off pauses hooks: they stay listed, inactive, and cannot be changed.
  rewrite(f, { ...stored, capabilities: { ...stored.capabilities, reminders: false } });
  assert.equal(f.hooks.list(f.id).hooks[0].active, false);
  assert.throws(() => f.hooks.create(f.id, base), {
    status: 403,
    key: "hookUnavailable",
  });
  assert.throws(() => f.hooks.update(f.id, hook.id, { revision: 1, name: "New" }), {
    status: 403,
  });
});

test("regenerating replaces the secret at once", async (t) => {
  const f = hookFixture(t);
  const { hook, secret } = await f.hooks.create(f.id, base);
  const next = await f.hooks.secret(f.id, hook.id, { revision: hook.revision });
  assert.notEqual(next.secret, secret);
  assert.equal(secretMatches(f.hooks.store.get(hook.id).secretHash, secret), false);
  assert.equal(secretMatches(f.hooks.store.get(hook.id).secretHash, next.secret), true);
  assert.equal(next.hook.revision, hook.revision + 1);
  assert.equal(JSON.stringify(f.audits).includes(next.secret), false);
  assert.deepEqual(f.audits.at(-1).details, {
    kind: "hook",
    hookId: hook.id,
    change: "secret",
  });
});

test("a stale revision conflicts and a rights increase above the ceiling is refused", async (t) => {
  const f = hookFixture(t);
  const { hook } = await f.hooks.create(f.id, base);
  const updated = await f.hooks.update(f.id, hook.id, {
    revision: hook.revision,
    name: "Zabbix prod",
    rights: { telegram: true },
    hourlyLimit: 50,
  });
  assert.equal(updated.name, "Zabbix prod");
  assert.equal(updated.rights.telegram, true);
  assert.equal(updated.effective.telegram, true);
  assert.equal(updated.hourlyLimit, 50);
  assert.deepEqual(f.audits.at(-1).details, {
    kind: "hook",
    hookId: hook.id,
    change: "update",
    rights: ["telegram"],
  });
  assert.throws(
    () => f.hooks.update(f.id, hook.id, { revision: hook.revision, name: "X" }),
    {
      status: 409,
    },
  );
  const count = f.audits.length;
  for (const rights of [{ coding: true }, { shell: "full" }, { sshHosts: ["h1"] }])
    assert.throws(
      () => f.hooks.update(f.id, hook.id, { revision: updated.revision, rights }),
      { status: 400, key: "hookRightExceeds" },
    );
  assert.throws(() => f.hooks.create(f.id, { ...base, rights: { memory: true } }), {
    status: 400,
    key: "hookRightExceeds",
  });
  assert.equal(f.audits.length, count);
  assert.equal(f.hooks.store.get(hook.id).revision, updated.revision);
});

test("pausing and enabling a hook are audited as such", async (t) => {
  const f = hookFixture(t);
  const { hook } = await f.hooks.create(f.id, base);
  const paused = await f.hooks.update(f.id, hook.id, {
    revision: hook.revision,
    enabled: false,
  });
  assert.equal(paused.enabled, false);
  assert.equal(paused.active, false);
  assert.equal(f.audits.at(-1).details.change, "pause");
  await f.hooks.update(f.id, hook.id, { revision: paused.revision, enabled: true });
  assert.equal(f.audits.at(-1).details.change, "enable");
});

test("hook input is validated", async (t) => {
  const f = hookFixture(t);
  for (const input of [
    {},
    { ...base, name: "" },
    { ...base, sender: "x".repeat(101) },
    { ...base, instruction: "x".repeat(4097) },
    { ...base, hourlyLimit: 0 },
    { ...base, hourlyLimit: 201 },
    { ...base, hourlyLimit: 1.5 },
    { ...base, secretHash: "x" },
  ])
    assert.throws(
      () => f.hooks.create(f.id, input),
      { status: 400 },
      JSON.stringify(input),
    );
  const { hook } = await f.hooks.create(f.id, base);
  for (const input of [
    { name: "New" },
    { revision: hook.revision, enabled: "yes" },
    { revision: hook.revision, secretSetAt: "x" },
  ])
    assert.throws(() => f.hooks.update(f.id, hook.id, input), { status: 400 });
});

test("a hook of another agent is not found", async (t) => {
  const f = hookFixture(t);
  const { hook } = await f.hooks.create(f.id, base);
  const other = f.store.createAssistant({
    name: "Other",
    model: { connectionId: "test", modelId: "fixture" },
  });
  f.store.updateAssistant(
    other.id,
    { capabilities: { memory: false, reminders: true } },
    1,
  );
  assert.equal(f.hooks.list(other.id).hooks.length, 0);
  for (const call of [
    () => f.hooks.owned(other.id, hook.id),
    () => f.hooks.update(other.id, hook.id, { revision: hook.revision, name: "X" }),
    () => f.hooks.secret(other.id, hook.id, { revision: hook.revision }),
    () => f.hooks.remove(other.id, hook.id),
    () => f.hooks.remove(f.id, "missing"),
  ])
    assert.throws(call, { status: 404 });
  assert.ok(f.hooks.store.get(hook.id));
});

test("removing a hook forgets its events and cancels its runs", async (t) => {
  const f = hookFixture(t);
  const { hook } = await f.hooks.create(f.id, base);
  const stored = f.hooks.store.get(hook.id);
  const { event } = f.hooks.events.admit(stored, {
    eventId: "e1",
    payload: "{}",
    size: 2,
    contentType: "application/json",
    source: "local",
  });
  assert.equal(f.hooks.list(f.id).hooks[0].lastEvent.status, "pending");
  const cancelled = [];
  f.hooks.runs = {
    cancel: async (id) => {
      cancelled.push(id);
      throw new Error("Gateway gone");
    },
  };
  assert.deepEqual(await f.hooks.remove(f.id, hook.id), { removed: true });
  assert.equal(f.hooks.store.get(hook.id), null);
  assert.equal(f.hooks.events.get(event.id), null);
  assert.deepEqual(cancelled, [hook.id]);
  assert.deepEqual(f.audits.at(-1).details, {
    kind: "hook",
    hookId: hook.id,
    change: "delete",
  });
});

test("an audit failure never fails the change", async (t) => {
  const f = hookFixture(t);
  f.assistants.audit = {
    append: () => {
      throw new Error("disk full");
    },
  };
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  const { hook } = await f.hooks.create(f.id, base);
  assert.ok(f.hooks.store.get(hook.id));
  assert.equal(logged.length, 1);
});

test("the graph reaches the service as assistantRoutines.hooks", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  assert.ok(f.application.assistantRoutines.hooks instanceof AgentHooks);
  assert.ok(f.application.assistantReminders.heartbeats);
});
