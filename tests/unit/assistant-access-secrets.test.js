import test from "node:test";
import assert from "node:assert/strict";
import { agentSshFixture } from "../helpers/agent-ssh-fixture.js";
import { SecretStore } from "../../server/features/secrets/secret-store.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { secretGrantList } from "../../server/features/assistants/agent-secret-grants.js";
import { TelegramSenders } from "../../server/features/assistant-channels/telegram-senders.js";

const owner = { kind: "owner" };

async function fixture(t) {
  const f = await agentSshFixture(t);
  const secrets = new SecretStore({ dataDir: f.dataDir });
  t.after(() => secrets.db.close());
  f.services.secrets = secrets;
  const save = (input, id = f.id) =>
    f.workflows.access.save(
      id,
      { ...f.policy, ...input },
      f.workflows.access.get(id).revision,
    );
  const secret = (name, value = `${name.toLowerCase()}-value`) =>
    secrets.create({ name, value }, owner);
  return { ...f, secrets, save, secret };
}

test("secret grants are validated, sorted and kept when a save leaves them out", async (t) => {
  const f = await fixture(t);
  const a = f.secret("ALPHA"),
    b = f.secret("BETA");
  assert.deepEqual(f.workflows.access.get(f.id).secretIds, []);
  const saved = f.save({ secretIds: [b.id, a.id] });
  assert.deepEqual(saved.secretIds, [a.id, b.id].sort());
  assert.deepEqual(f.save({}).secretIds, saved.secretIds);
  assert.deepEqual(f.workflows.access.secretIds(f.id), saved.secretIds);
  for (const value of ["all", [a.id, a.id], [1], [""], Array(51).fill(a.id)])
    assert.throws(() => f.save({ secretIds: value }), { status: 400 });
  assert.throws(() => f.save({ secretIds: ["missing"] }), {
    status: 409,
    key: "secretUnavailable",
  });
});

test("a deleted secret drops out on read and on save without blocking it", async (t) => {
  const f = await fixture(t);
  const a = f.secret("ALPHA"),
    b = f.secret("BETA");
  f.save({ secretIds: [a.id, b.id] });
  f.secrets.remove(a.id, owner);
  assert.deepEqual(f.workflows.access.get(f.id).secretIds, [b.id]);
  // A stale client still sending the deleted id saves; the id is dropped.
  assert.deepEqual(f.save({ secretIds: [a.id, b.id] }).secretIds, [b.id]);
  assert.deepEqual(f.save({ memoryWrite: false }).secretIds, [b.id]);
});

test("ineligible agents and agents with a bot for other people cannot hold secrets", async (t) => {
  const f = await fixture(t);
  const a = f.secret("ALPHA");
  const task = f.member({ lifetime: "task" });
  assert.throws(
    () => f.save({ projectIds: [], pipelineIds: [], secretIds: [a.id] }, task.id),
    {
      status: 403,
    },
  );
  f.services.assistantTelegramSenders = { connected: (id) => id === f.id };
  assert.throws(() => f.save({ secretIds: [a.id] }), {
    status: 409,
    key: "telegramSendersSecrets",
  });
  // No secrets is always accepted.
  assert.deepEqual(f.save({ secretIds: [] }).secretIds, []);
  assert.deepEqual(secretGrantList(f.services, f.id, []), []);
});

test("a user agent's secrets stay locked", async (t) => {
  const f = await fixture(t);
  const a = f.secret("ALPHA");
  f.store.changeUserAgent(f.id, {
    userAccess: { mode: "own", members: [{ userId: "u1", level: "chat" }], released: [] },
  });
  const input = {
    projectIds: [],
    pipelineIds: [],
    memoryWrite: false,
    autonomous: false,
    publish: false,
  };
  assert.throws(() => f.workflows.access.save(f.id, { ...input, secretIds: [a.id] }, 0), {
    status: 409,
    code: "USER_AGENT_LOCKED",
  });
  assert.deepEqual(
    f.workflows.access.save(f.id, { ...input, secretIds: [] }, 0).secretIds,
    [],
  );
});

test("grant changes are audited by name, never by value", async (t) => {
  const f = await fixture(t);
  const a = f.secret("ALPHA", "alpha-hunter2"),
    b = f.secret("BETA", "beta-hunter2");
  f.save({ secretIds: [a.id] });
  f.save({ secretIds: [b.id] });
  f.save({ memoryWrite: false });
  const changes = f.audit.filter(
    (e) => e.action === "assistant.updated" && e.details.kind === "secret-grants",
  );
  assert.equal(changes.length, 2);
  assert.deepEqual(changes[0].details, {
    kind: "secret-grants",
    revision: 1,
    added: ["ALPHA"],
    removed: [],
  });
  assert.deepEqual(changes[1].details, {
    kind: "secret-grants",
    revision: 2,
    added: ["BETA"],
    removed: ["ALPHA"],
  });
  assert.equal(changes[1].resourceId, f.id);
  assert.equal(JSON.stringify(f.audit).includes("hunter2"), false);
  // The schema keeps only well-formed names.
  const event = auditEvent({
    action: "assistant.updated",
    resourceType: "assistant",
    resourceId: f.id,
    source: "user",
    outcome: "success",
    details: { kind: "secret-grants", added: ["OK", "bad name", 3], removed: "X" },
  });
  assert.deepEqual(event.details, { kind: "secret-grants", added: ["OK"] });
});

test("a bot for other people is refused for an agent holding secrets", async (t) => {
  const f = await fixture(t);
  const a = f.secret("ALPHA");
  f.save({ secretIds: [a.id] });
  const senders = new TelegramSenders({
    store: { get: () => null },
    assistants: f.assistants,
    secretsGranted: (id) => f.workflows.access.secretIds(id).length > 0,
  });
  assert.throws(() => senders.eligible(f.id), {
    status: 409,
    key: "telegramSendersSecrets",
  });
  f.save({ secretIds: [] });
  assert.equal(senders.eligible(f.id).id, f.id);
});
