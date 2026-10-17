import test from "node:test";
import assert from "node:assert/strict";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { AssistantWorkflows } from "../../server/features/assistants/assistant-workflows.js";

async function approvedWrite(f, input) {
  const proposal = await f.workflows.invoke(await f.invocation(), {
    action: "memory_write",
    projectId: f.project.id,
    ...input,
  });
  await f.workflows.decide(
    proposal.id,
    { revision: proposal.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  return f.workflows.get(proposal.id);
}
function storedBodies(f) {
  return JSON.stringify(
    f.assistants.store.db.prepare("SELECT body FROM assistant_actions").all(),
  );
}

test("forgetting an entry redacts the approved agent writes that stored it", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const done = await approvedWrite(f, {
    title: "Token",
    content: "fixture-agent-secret",
  });
  assert.equal(done.state, "completed");
  const other = await approvedWrite(f, { title: "Kept", content: "unrelated note" });
  assert.equal(storedBodies(f).includes("fixture-agent-secret"), true);
  const result = f.memory.forget(f.project.id, done.result.id, { expectedRevision: 1 });
  assert.equal(result.purged, true);
  const redacted = f.workflows.get(done.id);
  assert.equal(redacted.state, "completed");
  assert.equal(redacted.payload.title, "");
  assert.equal(redacted.payload.content, "");
  assert.equal(redacted.diagnostic, "MEMORY_FORGOTTEN");
  assert.equal(f.workflows.get(other.id).payload.content, "unrelated note");
  assert.equal(storedBodies(f).includes("fixture-agent-secret"), false);
});

test("agent services started after a forget redact its earlier writes", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const done = await approvedWrite(f, { title: "Token", content: "fixture-late-secret" });
  f.memory.onForget = null; // The agent services were not running.
  f.memory.forget(f.project.id, done.result.id, { expectedRevision: 1 });
  assert.equal(f.workflows.get(done.id).payload.content, "fixture-late-secret");
  const restarted = new AssistantWorkflows({ services: f.services, autoStart: false });
  t.after(() => restarted.close());
  assert.equal(restarted.get(done.id).payload.content, "");
  assert.equal(f.memory.onForget !== null, true);
});

test("an approved write of forgotten text fails definitively instead of staying unknown", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const entry = f.memory.write(f.project.id, { title: "Token", content: "fixture-x" });
  f.memory.forget(f.project.id, entry.id, { expectedRevision: 1 });
  const refused = await approvedWrite(f, { title: "Token", content: "fixture-x" });
  assert.equal(refused.state, "failed");
  assert.equal(refused.diagnostic, "MEMORY_FORGOTTEN");
  assert.equal(storedBodies(f).includes("fixture-x"), false);
});

const telegram = (f) => ({
  kind: "telegram",
  channelId: f.channel.id,
  chatId: "42",
  userId: "42",
});
async function proposal(f, input, origin = { kind: "owner" }) {
  return f.workflows.invoke(await f.invocation(undefined, origin), {
    action: "memory_write",
    projectId: f.project.id,
    ...input,
  });
}
function outboxBodies(f) {
  return JSON.stringify(
    f.service.outbox.db.prepare("SELECT state,body FROM channel_outbox").all(),
  );
}

test("forgetting redacts Telegram notices and cancels pending updates of the entry", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const entry = f.memory.write(f.project.id, { title: "Token", content: "plain" });
  const update = { id: entry.id, expectedRevision: 1, title: "Token" };
  const waiting = await proposal(
    f,
    { ...update, content: "fixture-tg-secret" },
    telegram(f),
  );
  await f.workflows.tick();
  const approved = await proposal(f, { ...update, content: "fixture-approved-secret" });
  await f.workflows.decide(
    approved.id,
    { revision: approved.revision, decision: "approve" },
    { kind: "owner" },
  );
  assert.equal(f.workflows.get(approved.id).state, "approved");
  assert.equal(outboxBodies(f).includes("fixture-tg-secret"), true);
  f.memory.forget(f.project.id, entry.id, { expectedRevision: 1 });
  for (const id of [waiting.id, approved.id]) {
    const a = f.workflows.get(id);
    assert.equal(a.state, "cancelled");
    assert.equal(a.diagnostic, "MEMORY_FORGOTTEN");
  }
  assert.equal(outboxBodies(f).includes("fixture-tg-secret"), false);
  const [notice] = f.service.outbox.all();
  assert.equal(notice.state, "reviewed");
  assert.equal(notice.diagnostic, "MEMORY_FORGOTTEN");
  assert.equal(storedBodies(f).includes("fixture-approved-secret"), false);
});

test("the agent hears about a cancelled or refused forgotten write without its title", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const sends = [];
  const send = f.assistants.send;
  f.assistants.send = async (conversationId, input, context) => {
    if (context?.kind === "memory-result") sends.push(input.text);
    return send(conversationId, input, context);
  };
  const entry = f.memory.write(f.project.id, { title: "Secret title", content: "a" });
  const inv = await f.invocation();
  const pending = await f.workflows.invoke(inv, {
    action: "memory_write",
    projectId: f.project.id,
    id: entry.id,
    expectedRevision: 1,
    title: "Secret title",
    content: "b",
  });
  f.assistants.ledger.transition(inv.attemptId, "completed");
  f.memory.forget(f.project.id, entry.id, { expectedRevision: 1 });
  assert.equal(f.workflows.get(pending.id).state, "cancelled");
  await f.workflows.tick();
  await f.workflows.tick();
  assert.equal(sends.length, 1);
  assert.match(sends[0], /was not saved \(cancelled\)/);
  assert.match(sends[0], /permanently removed/);
  assert.equal(sends[0].includes("Secret title"), false);
  const second = await f.invocation();
  const refused = await f.workflows.invoke(second, {
    action: "memory_write",
    projectId: f.project.id,
    title: "Secret title",
    content: "a",
  });
  f.assistants.ledger.transition(second.attemptId, "completed");
  await f.workflows.decide(
    refused.id,
    { revision: refused.revision, decision: "approve" },
    { kind: "owner" },
  );
  await f.workflows.tick();
  await f.workflows.tick();
  assert.equal(f.workflows.get(refused.id).state, "failed");
  assert.equal(sends.length, 2);
  assert.match(sends[1], /was not saved \(failed\): the owner permanently removed/);
  assert.equal(sends[1].includes('your note ""'), false);
  assert.equal(sends[1].includes("Secret title"), false);
});

test("a throwing redaction hook still forgets and reports the records separately", async (t) => {
  const f = await workflowFixture(t);
  f.workflows.access.save(f.id, f.policy, 0);
  const done = await approvedWrite(f, { title: "Token", content: "fixture-hook-secret" });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => (console.error = original));
  const hook = f.memory.onForget;
  f.memory.onForget = () => {
    throw new Error("fixture-hook-secret");
  };
  const result = f.memory.forget(f.project.id, done.result.id, { expectedRevision: 1 });
  console.error = original;
  assert.equal(result.purged, true);
  assert.equal(result.redacted, false);
  assert.equal(result.notice, serverMessages.memory.recordsPending);
  assert.throws(() => f.memory.read(f.project.id, done.result.id), { status: 404 });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].includes("fixture-hook-secret"), false);
  // The next forget (or start) retries the redaction through the restored hook.
  f.memory.onForget = hook;
  const other = f.memory.write(f.project.id, { title: "Other", content: "x" });
  assert.equal(
    f.memory.forget(f.project.id, other.id, { expectedRevision: 1 }).redacted,
    true,
  );
  assert.equal(storedBodies(f).includes("fixture-hook-secret"), false);
});

test("closing the agent services unsets the redaction hook", async (t) => {
  const f = await workflowFixture(t);
  assert.equal(typeof f.memory.onForget, "function");
  await f.workflows.close();
  assert.equal(f.memory.onForget, null);
});
