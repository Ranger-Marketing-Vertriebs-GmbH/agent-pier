import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { teamFixture } from "../helpers/assistant-team-fixture.js";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import {
  MemoryStep,
  memoryStepText,
} from "../../server/features/assistants/memory-step.js";

const fast = { limitMs: 200, pollMs: 5, idleMs: 200 };

// A chat of the fixture's owner agent with memory on and the write guard live.
function setup(t, { writeGuard = true } = {}) {
  const f = teamFixture(t);
  const agent = f.store.createAssistant({
    name: "Home",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: true, reminders: false },
  });
  const chat = f.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: `home-${agent.id}`,
  });
  f.assistants.config.writeGuard = () => writeGuard;
  const step = new MemoryStep({ service: f.assistants, ...fast });
  const attempts = () =>
    f.assistants.ledger
      .requests(chat.id)
      .map((r) => f.assistants.ledger.attemptFor(r.id));
  return { ...f, agent, chat, step, attempts };
}

// Settles the step's attempt once the step sent it.
async function settle(f, status) {
  while (!f.attempts().length) await new Promise((r) => setTimeout(r, 2));
  f.complete(f.attempts()[0].id, status);
}

// Eligibility on an agent record as the store reads it.
const eligibleFor = (agent, writeGuard = true) =>
  new MemoryStep({
    service: {
      store: { getAssistant: () => agent },
      config: { writeGuard: () => writeGuard },
    },
  }).eligible({ id: "chat", assistantId: "agent" });

test("the step runs only where the agent may write its own memory", () => {
  const own = { id: "a", runtimeAgentId: "a", capabilities: { memory: true } };
  assert.equal(eligibleFor(own), true);
  // A user's private chat on her own agent.
  assert.equal(eligibleFor({ ...own, userAccess: { mode: "own", members: [] } }), true);
  assert.equal(eligibleFor({ ...own, capabilities: { memory: false } }), false);
  assert.equal(eligibleFor({ ...own, capabilities: {} }), false);
  // The write guard is not proven.
  assert.equal(eligibleFor(own, false), false);
  // A shared agent keeps memories from every chat in its shared memory.
  assert.equal(
    eligibleFor({ ...own, userAccess: { mode: "shared", members: [], released: [] } }),
    true,
  );
  assert.equal(eligibleFor({ ...own, archivedAt: "2026-10-23T00:00:00Z" }), false);
  // A temporary member runs with its lead's capabilities.
  const member = {
    id: "m",
    teamMemberId: "tm",
    lifetime: "temporary",
    capabilities: { memory: false },
  };
  assert.equal(
    eligibleFor({ ...member, inherited: { capabilities: { memory: true } } }),
    true,
  );
  assert.equal(
    eligibleFor({
      ...member,
      capabilities: { memory: true },
      inherited: { capabilities: { memory: false } },
    }),
    false,
  );
  // A permanent member has its own settings.
  assert.equal(
    eligibleFor({ ...member, lifetime: "permanent", capabilities: { memory: true } }),
    true,
  );
});

test("a completed step saved the memories, in a hidden memory-step turn", async (t) => {
  const f = setup(t);
  const run = f.step.run(f.chat);
  await settle(f, "ok");
  assert.deepEqual(await run, { saved: true });
  const [request] = f.assistants.ledger.requests(f.chat.id);
  assert.match(request.clientRequestId, /^memory-step:[0-9a-f-]{36}$/);
  assert.equal(request.text, memoryStepText);
  assert.deepEqual(f.service.store.context(request.id).kind, "memory-step");
  const sent = f.calls.find((c) => c.method === "sessions.send");
  assert.equal(sent.input.key, f.chat.runtimeSessionKey);
});

test("a failed step saved nothing", async (t) => {
  const f = setup(t);
  const run = f.step.run(f.chat);
  await settle(f, "error");
  assert.deepEqual(await run, { saved: false, reason: "failed" });
});

test("a step stopped from elsewhere was interrupted", async (t) => {
  const f = setup(t);
  const run = f.step.run(f.chat);
  while (!f.attempts().length) await new Promise((r) => setTimeout(r, 2));
  f.assistants.ledger.transition(f.attempts()[0].id, "cancelled");
  assert.deepEqual(await run, { saved: false, reason: "interrupted" });
});

test("a refused step saved nothing and sent nothing", async (t) => {
  const f = setup(t);
  // A turn is still running in the chat.
  const busy = f.assistants.ledger.accept(f.chat.id, {
    clientRequestId: "x",
    text: "Hi",
  });
  f.assistants.ledger.recordAttempt(busy.id);
  assert.deepEqual(await f.step.run(f.chat), { saved: false, reason: "refused" });
  assert.equal(f.calls.filter((c) => c.method === "sessions.send").length, 0);
});

test("a step over its limit is aborted as Stop does, and ends once the chat is idle", async (t) => {
  const f = setup(t);
  const aborts = [];
  const cancel = f.assistants.cancel.bind(f.assistants);
  let idleAt = 0;
  f.assistants.cancel = async (id) => {
    aborts.push(id);
    // The Gateway takes the abort; the reconciler settles the run a little later.
    setTimeout(() => {
      idleAt = Date.now();
      f.assistants.ledger.transition(id, "cancelled");
    }, 50);
    return cancel(id);
  };
  const started = Date.now();
  const result = await f.step.run(f.chat);
  assert.deepEqual(result, { saved: false, reason: "timeout" });
  assert.deepEqual(aborts, [f.attempts()[0].id]);
  assert.ok(Date.now() - started >= fast.limitMs);
  assert.ok(idleAt > 0 && Date.now() >= idleAt, "returned only after the run ended");
  const abort = f.calls.find((c) => c.method === "sessions.abort");
  assert.equal(abort.input.key, f.chat.runtimeSessionKey);
  assert.equal(f.assistants.ledger.getAttempt(aborts[0]).state, "cancelled");
});

test("a step's abort that never settles still ends after its idle bound", async (t) => {
  const f = setup(t);
  f.assistants.cancel = async () => {
    throw Object.assign(Error("unavailable"), { status: 503 });
  };
  const result = await f.step.run(f.chat);
  assert.deepEqual(result, { saved: false, reason: "timeout" });
});

test("a memory step's reply never reaches Telegram", async (t) => {
  const f = channelFixture(t, { language: () => "en" });
  const sends = [];
  f.client.call = async (method, params) => {
    sends.push({ method, params });
    return { message_id: sends.length, chat: { id: 42 } };
  };
  f.assistants.config = { writeGuard: () => true };
  f.assistants.cancel = async () => {};
  const step = new MemoryStep({ service: f.assistants, ...fast });
  const conversation = f.store.getConversation(f.channel.conversationId);
  const run = step.run(conversation);
  while (!f.sent.length) await new Promise((r) => setTimeout(r, 2));
  const [request] = f.assistants.ledger.requests(conversation.id);
  f.assistants.ledger.transition(
    f.assistants.ledger.attemptFor(request.id).id,
    "completed",
  );
  f.assistants.history = async () => ({
    stale: false,
    messages: [{ role: "assistant", text: "Saved.", runId: request.id }],
  });
  assert.deepEqual(await run, { saved: true });
  assert.equal(f.contexts[0].kind, "memory-step");
  await f.service.process(f.channel.id, new AbortController().signal);
  assert.deepEqual(f.service.ledger.list(f.channel.id), []);
  assert.deepEqual(sends, []);
});

test("only the memory step creates the memory-step context kind", () => {
  const root = path.resolve(import.meta.dirname, "../../server");
  const files = fs
    .readdirSync(root, { recursive: true })
    .filter((file) => file.endsWith(".js"))
    .filter((file) =>
      /kind:\s*["']memory-step["']/.test(fs.readFileSync(path.join(root, file), "utf8")),
    );
  assert.deepEqual(files, [path.join("features", "assistants", "memory-step.js")]);
});

test("no send input can carry its own context", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.assistants.send(f.chat.id, {
      clientRequestId: "own",
      text: "Save",
      context: { kind: "memory-step" },
    }),
    { status: 400 },
  );
});
