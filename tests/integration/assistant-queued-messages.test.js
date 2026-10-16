import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";

// One agent conversation on a scripted Gateway: `finish(runId, status)` ends a run.
function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-queued-"));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces);
  const sent = [];
  const runs = new Map();
  const services = [];
  const start = () => {
    const store = new AssistantStore({ dataDir });
    const client = new EventEmitter();
    client.ready = true;
    client.subscribe = () => () => {};
    client.call = async (method, params) => {
      if (method === "sessions.send") {
        sent.push(params);
        return { runId: params.idempotencyKey };
      }
      if (method === "sessions.abort") {
        runs.set(params.runId, { status: "aborted" });
        return {};
      }
      if (method === "agent.wait")
        return runs.get(params.runId)
          ? { ...runs.get(params.runId), runId: params.runId }
          : { status: "timeout" };
      if (method === "chat.history") return { messages: [], hasMore: false };
      if (method === "sessions.messages.subscribe") return {};
      if (method === "sessions.describe") return { session: {} };
      assert.fail(method);
    };
    const runtime = new EventEmitter();
    runtime.client = client;
    runtime.close = async () => {};
    runtime.setState = () => {};
    const service = new AssistantService({
      store,
      runtime,
      models: {
        listCapabilities: () => [],
        resolve: () => ({ release() {} }),
        imageInput: () => true,
      },
      config: { apply: async () => {}, reset() {}, workspaces },
    });
    services.push(service);
    return { service, store, client };
  };
  t.after(async () => {
    for (const service of services) if (!service.closed) await service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const first = start();
  const a = first.store.createAssistant({
    name: "lead",
    model: { connectionId: "c", modelId: "m" },
  });
  const c = first.store.saveConversation({
    assistantId: a.id,
    runtimeSessionKey: "lead",
  });
  const finish = async (service, status = "ok", extra = {}) => {
    runs.set(sent.at(-1).idempotencyKey, { status, ...extra });
    await service.reconcile();
    // The dispatch runs after the reconcile pass; let it reach sessions.send.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return { ...first, start, c, sent, finish };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

test("a queued message waits for the turn and is sent once after it completes", async (t) => {
  const { service, c, sent, finish } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "Plan the week" });
  const queued = service.queue(c.id, { text: "Add a dessert" });
  assert.equal(queued.state, "waiting");
  service.queue(c.id, { text: "Without nuts", teamAllowed: true });
  await settle();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { ...(await service.history(c.id)).queued, updatedAt: undefined },
    {
      text: "Add a dessert\nWithout nuts",
      teamAllowed: true,
      attachments: [],
      state: "waiting",
      updatedAt: undefined,
    },
  );
  await finish(service);
  assert.equal(sent.length, 2);
  assert.match(sent[1].message, /^Add a dessert\nWithout nuts/);
  assert.equal((await service.history(c.id)).queued, null);
  const requests = service.ledger.requests(c.id);
  assert.equal(requests.length, 2);
  // Further passes send nothing again.
  await service.reconcile();
  await settle();
  assert.equal(sent.length, 2);
});

test("Stop ends the turn and the queued message follows; a failed turn too", async (t) => {
  const { service, c, sent, finish } = setup(t);
  const { attempt } = await service.send(c.id, { clientRequestId: "first", text: "One" });
  service.queue(c.id, { text: "Start over" });
  await service.cancel(attempt.id);
  await settle();
  assert.equal(sent.length, 2);
  assert.match(sent[1].message, /^Start over/);
  service.queue(c.id, { text: "After failure" });
  await finish(service, "error");
  assert.equal(sent.length, 3);
});

test("an uncertain turn holds the queued message until it is reviewed", async (t) => {
  const { service, c, sent } = setup(t);
  const { attempt } = await service.send(c.id, { clientRequestId: "first", text: "One" });
  service.ledger.transition(attempt.id, "uncertain");
  service.queue(c.id, { text: "Next" });
  await service.reconcile();
  await settle();
  assert.equal(sent.length, 1);
  service.ledger.review(attempt.id);
  await service.reconcile();
  await settle();
  assert.equal(sent.length, 2);
});

test("a queued message survives a restart and a dispatch cut off is not sent twice", async (t) => {
  const { service, start, c, sent, finish } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  service.queue(c.id, { text: "After the restart" });
  // The dispatch was accepted, but the process ended before it was recorded as done.
  const message = service.queued.get(c.id);
  assert.equal(service.queued.begin(message), true);
  await finish(service);
  await service.send(c.id, {
    clientRequestId: message.clientRequestId,
    text: message.text,
  });
  assert.equal(sent.length, 2);
  await service.close();

  const next = start().service;
  // The ledger took it: the restart drops the row instead of offering it again.
  assert.equal(next.queued.get(c.id), null);
  assert.equal((await next.history(c.id)).queued, null);
  await finish(next);
  assert.equal(sent.length, 2);
  assert.equal(next.ledger.requests(c.id).length, 2);
});

test("taking the message back returns it, and is refused once its dispatch began", async (t) => {
  const { service, c, sent, finish } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  const file = await service.attachments.stage(
    c.id,
    "notes.md",
    Buffer.from("# Notes\n"),
  );
  service.queue(c.id, { text: "Use these", attachments: [file.id] });
  assert.deepEqual(service.takeBackQueued(c.id), {
    text: "Use these",
    teamAllowed: false,
    attachments: [file],
  });
  assert.throws(() => service.takeBackQueued(c.id), { status: 404 });
  await finish(service);
  assert.equal(sent.length, 1);

  await service.send(c.id, { clientRequestId: "second", text: "Two" });
  service.queue(c.id, { text: "Racing", attachments: [file.id] });
  const message = service.queued.get(c.id);
  assert.equal(service.queued.begin(message), true);
  assert.throws(() => service.takeBackQueued(c.id), {
    status: 409,
    key: "queuedSending",
  });
  assert.throws(() => service.queue(c.id, { text: "More" }), {
    status: 409,
    key: "queuedSending",
  });
  service.queued.release(message);
  assert.equal(service.takeBackQueued(c.id).text, "Racing");
});

test("queued files stay staged and protected until the message takes them", async (t) => {
  const { service, c, sent, finish } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  const file = await service.attachments.stage(
    c.id,
    "notes.md",
    Buffer.from("# Notes\n"),
  );
  service.queue(c.id, { text: "", attachments: [file.id] });
  await assert.rejects(service.attachments.discard(c.id, file.id), {
    status: 409,
    key: "queuedAttachment",
  });
  // Older than a day, a staged file is swept, unless a queued message names it.
  service.attachments.now = () => Date.now() + 2 * 24 * 3600 * 1000;
  await service.attachments.stage(c.id, "other.md", Buffer.from("# Other\n"));
  assert.deepEqual(
    (await service.history(c.id)).queued.attachments.map((f) => f.id),
    [file.id],
  );
  await finish(service);
  assert.equal(sent.length, 2);
  assert.match(sent[1].message, /notes\.md/);
  assert.deepEqual(
    service.ledger.requests(c.id).map((r) => service.attachments.files(r.id).length),
    [0, 1],
  );
});

test("queueing follows the send limits and refuses foreign or doubled files", async (t) => {
  const { service, c, store } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  assert.throws(() => service.queue(c.id, { text: " " }), { status: 400 });
  assert.throws(() => service.queue(c.id, { text: "x", clientRequestId: "k" }), {
    status: 400,
  });
  assert.throws(() => service.queue(c.id, { text: "x", attachments: ["missing"] }), {
    status: 404,
  });
  service.queue(c.id, { text: "a".repeat(65530) });
  assert.throws(() => service.queue(c.id, { text: "more text" }), {
    status: 413,
    key: "queuedTooLong",
  });
  const other = store.saveConversation({
    assistantId: store.getConversation(c.id).assistantId,
    runtimeSessionKey: "other",
  });
  const foreign = await service.attachments.stage(other.id, "x.md", Buffer.from("x"));
  assert.throws(() => service.queue(c.id, { text: "x", attachments: [foreign.id] }), {
    status: 404,
  });
});

test("a refused delivery is kept as failed with its reason instead of retried", async (t) => {
  const { service, c, sent, finish } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  const file = await service.attachments.stage(c.id, "notes.md", Buffer.from("# N\n"));
  service.queue(c.id, { text: "With a file", attachments: [file.id] });
  // The file disappears from the staging index before the turn ends.
  service.store.db.prepare("DELETE FROM agent_attachments WHERE id=?").run(file.id);
  await finish(service);
  assert.equal(sent.length, 1);
  const { queued } = await service.history(c.id);
  assert.equal(queued.state, "failed");
  assert.equal(queued.messageKey, "assistants.attachmentNotFound");
  await service.reconcile();
  await settle();
  assert.equal(sent.length, 1);
});

test("an append after a restart never sends the delivered message again", async (t) => {
  const { service, start, c, sent, finish } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  service.queue(c.id, { text: "Queued A" });
  const message = service.queued.get(c.id);
  service.queued.begin(message);
  await finish(service);
  // The ledger took it; the process ended before the queue row was removed.
  await service.send(c.id, {
    clientRequestId: message.clientRequestId,
    text: message.text,
  });
  await service.close();
  const next = start().service;
  assert.equal(next.queued.get(c.id), null);
  next.queue(c.id, { text: "B" });
  await finish(next);
  assert.deepEqual(
    sent.map((s) => s.message),
    ["One", "Queued A", "B"],
  );
});

for (const [label, status] of [
  ["an unready service", 503],
  ["a busy member", 409],
])
  test(`a refusal by ${label} is retried by the poll with backoff, quietly`, async (t) => {
    const { service, c, sent, finish } = setup(t);
    let clock = Date.now();
    service.now = () => clock;
    await service.send(c.id, { clientRequestId: "first", text: "One" });
    service.queue(c.id, { text: "Later" });
    const send = service.send.bind(service);
    let refusals = 2;
    service.send = async (...args) => {
      if (refusals-- > 0) throw Object.assign(new Error("refused"), { status });
      return send(...args);
    };
    await finish(service);
    assert.equal(service.queued.get(c.id).state, "waiting");
    assert.equal(service.ledger.unresolved().length, 0);
    const changes = [];
    const stop = service.events.subscribe((event) => changes.push(event.type));
    // Within the first backoff the poll leaves it alone.
    service.pollReconcile();
    await settle();
    assert.equal(refusals, 1);
    clock += 2100;
    service.pollReconcile();
    await settle();
    assert.equal(refusals, 0);
    assert.equal(sent.length, 1);
    // A refusal that only returns it to waiting is no news for the browsers.
    assert.deepEqual(changes, []);
    clock += 2100;
    service.pollReconcile();
    await settle();
    assert.equal(sent.length, 1, "the backoff doubled to 4 s");
    clock += 2100;
    service.pollReconcile();
    await settle();
    assert.equal(sent.length, 2);
    assert.equal(service.queued.get(c.id), null);
    stop?.();
  });

test("an unexpected failure never shows its internal text and is not retried", async (t) => {
  const { service, c, sent, finish } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  service.queue(c.id, { text: "X" });
  service.config.apply = async () => {
    throw new Error("ENOENT: /secret/path/openclaw.json");
  };
  await finish(service);
  const { queued } = await service.history(c.id);
  assert.equal(queued.state, "failed");
  assert.equal(JSON.stringify(queued).includes("/secret/path"), false);
  assert.equal(queued.messageKey, "http.internalError");
  // A failed message takes no more text until the owner edits it.
  assert.throws(() => service.queue(c.id, { text: "More" }), {
    status: 409,
    key: "queuedFailed",
  });
  assert.equal(sent.length, 1);
});

test("a repeated append with the same key adds its text once", async (t) => {
  const { service, c } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  service.queue(c.id, { text: "Add a dessert", appendId: "enter-1" });
  service.queue(c.id, { text: "Add a dessert", appendId: "enter-1" });
  assert.equal(service.queued.get(c.id).text, "Add a dessert");
  service.queue(c.id, { text: "Without nuts", appendId: "enter-2" });
  assert.equal(service.queued.get(c.id).text, "Add a dessert\nWithout nuts");
});

test("archived agents take no queued messages, and old ones are not sent days later", async (t) => {
  const { service, store, c, sent, finish } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  let clock = Date.now();
  service.now = () => clock;
  service.queued.now = () => clock;
  service.queue(c.id, { text: "Stale" });
  clock += 25 * 3600 * 1000;
  await finish(service);
  const { queued } = await service.history(c.id);
  assert.equal(queued.state, "failed");
  assert.equal(queued.messageKey, "assistants.queuedExpired");
  assert.equal(sent.length, 1);

  service.takeBackQueued(c.id);
  const { assistantId } = store.getConversation(c.id);
  store.db
    .prepare("UPDATE assistants SET body=json_set(body,'$.archivedAt',?) WHERE id=?")
    .run(new Date().toISOString(), assistantId);
  assert.throws(() => service.queue(c.id, { text: "Archived" }), {
    status: 409,
    key: "queuedArchived",
  });
});

test("taking a message back restarts its files' staging time", async (t) => {
  const { service, c } = setup(t);
  await service.send(c.id, { clientRequestId: "first", text: "One" });
  const file = await service.attachments.stage(c.id, "notes.md", Buffer.from("# N\n"));
  const later = Date.now() + 3600 * 1000;
  service.queue(c.id, { text: "", attachments: [file.id] });
  service.attachments.now = () => later;
  service.takeBackQueued(c.id);
  const row = service.store.db
    .prepare("SELECT created_at FROM agent_attachments WHERE id=?")
    .get(file.id);
  assert.equal(row.created_at, later);
});
