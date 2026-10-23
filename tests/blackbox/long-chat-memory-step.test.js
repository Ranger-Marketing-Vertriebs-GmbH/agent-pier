import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import {
  MemoryStep,
  memoryStepText,
} from "../../server/features/assistants/memory-step.js";

// AGENTPIER-194: Summarise now first runs the memory step (memory-step.js) where the
// agent may write its memory, then OpenClaw's `sessions.compact`. The request answers
// at once that the summary runs; the chat shows "saving memories" meanwhile, takes no
// turn and queues a message, and shows every end as its notice. A step that saved
// nothing still summarises and the chat says so.

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
const running = { compacted: false, running: true };
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function fixture(t, { memory = true, step = {} } = {}) {
  const { f, gateway } = await chatFixture(t);
  const assistants = f.application.assistants;
  assistants.config.writeGuard = () => true;
  assistants.longChats.memoryStep = new MemoryStep({
    service: assistants,
    limitMs: 60000,
    pollMs: 5,
    idleMs: 100,
    ...step,
  });
  const compacted = [];
  const base = gateway.client.call;
  gateway.client.call = async (method, params, options) => {
    if (method === "sessions.compact") {
      gateway.calls.push({ method, params });
      compacted.push(params.key);
      return { ok: true, key: params.key, compacted: true };
    }
    return base(method, params, options);
  };
  const agent = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: {
        name: "Helper",
        instructions: "",
        model: fixtureModel(f),
        capabilities: { memory, reminders: false },
      },
    }),
    201,
  );
  const id = (
    await json(
      await f.request(`/api/assistants/${agent.id}/conversations`, { method: "POST" }),
      200,
    )
  ).id;
  const chat = `/api/assistant-conversations/${id}`;
  const history = async () => json(await f.request(`${chat}/messages`), 200);
  const stepSends = () => gateway.sent.filter((s) => s.message === memoryStepText);
  const otherSends = () => gateway.sent.filter((s) => s.message !== memoryStepText);
  // Ends the memory step's run with `status` (agent.wait), as the reconciler sees it.
  const endStep = async (status) => {
    await until(() => stepSends().length === 1, "the memory step");
    gateway.runs[stepSends()[0].idempotencyKey] = { status };
    await assistants.reconcile();
  };
  const summarise = () => f.request(`${chat}/compact`, { method: "POST" });
  const ended = () =>
    until(async () => (await history()).compacting === false, "the summary's end");
  const order = () =>
    gateway.calls
      .filter((c) => c.method === "sessions.compact" || c.method === "sessions.send")
      .map((c) => c.method);
  return {
    f,
    gateway,
    assistants,
    id,
    chat,
    history,
    stepSends,
    otherSends,
    endStep,
    summarise,
    ended,
    compacted,
    order,
  };
}

test("an agent that may write its memory saves it first, then summarises", async (t) => {
  const x = await fixture(t);
  assert.deepEqual(await json(await x.summarise(), 200), running);
  await until(() => x.stepSends().length === 1, "the memory step");
  const during = await x.history();
  assert.equal(during.compacting, "memory");
  assert.equal(x.compacted.length, 0);
  // The chat takes no turn meanwhile.
  const sent = await x.f.request(`${x.chat}/messages`, {
    method: "POST",
    body: { clientRequestId: "during", text: "Hello" },
  });
  assert.equal(sent.status, 409);
  await x.endStep("ok");
  await x.ended();
  assert.deepEqual(x.order(), ["sessions.send", "sessions.compact"]);
  const after = await x.history();
  assert.equal(after.memoryNotSaved, undefined);
  assert.equal(after.compactOutcome, undefined);
});

test("an agent without memory summarises at once", async (t) => {
  const x = await fixture(t, { memory: false });
  assert.deepEqual(await json(await x.summarise(), 200), { compacted: true });
  assert.deepEqual(x.order(), ["sessions.compact"]);
  assert.equal((await x.history()).memoryNotSaved, undefined);
});

test("a failed memory step still summarises, and the chat says nothing was saved", async (t) => {
  const x = await fixture(t);
  assert.deepEqual(await json(await x.summarise(), 200), running);
  await x.endStep("error");
  await x.ended();
  assert.deepEqual(x.order(), ["sessions.send", "sessions.compact"]);
  const after = await x.history();
  assert.equal(after.memoryNotSaved, true);
  assert.equal(after.compactOutcome, undefined);
  // The notice goes once the person writes again.
  assert.equal(
    (
      await x.f.request(`${x.chat}/messages`, {
        method: "POST",
        body: { clientRequestId: "next", text: "Next" },
      })
    ).status,
    202,
  );
  assert.equal((await x.history()).memoryNotSaved, undefined);
});

test("a timed-out memory step is aborted, then the chat is summarised", async (t) => {
  const x = await fixture(t, { step: { limitMs: 60 } });
  assert.deepEqual(await json(await x.summarise(), 200), running);
  await until(() => x.compacted.length === 1, "the summary");
  await x.ended();
  assert.ok(x.gateway.calls.some((c) => c.method === "sessions.abort"));
  assert.deepEqual(x.order(), ["sessions.send", "sessions.compact"]);
  assert.equal((await x.history()).memoryNotSaved, true);
});

test("a timed-out step whose run does not end leaves the chat busy, not hanging", async (t) => {
  const x = await fixture(t, { step: { limitMs: 60, idleMs: 60 } });
  // The abort never ends the run.
  x.assistants.cancel = async () => {};
  assert.deepEqual(await json(await x.summarise(), 200), running);
  await x.ended();
  assert.equal(x.compacted.length, 0);
  // Every tab, also one opened later, reads why the summary did not run.
  const after = await x.history();
  assert.equal(after.compactOutcome, "busy");
  assert.equal(after.memoryNotSaved, true);
});

test("a second click while memories are saved joins the running summary", async (t) => {
  const x = await fixture(t);
  assert.deepEqual(await json(await x.summarise(), 200), running);
  await until(() => x.stepSends().length === 1, "the memory step");
  assert.deepEqual(await json(await x.summarise(), 200), running);
  await tick(40);
  await x.endStep("ok");
  await x.ended();
  assert.equal(x.stepSends().length, 1);
  assert.equal(x.compacted.length, 1);
});

test("a Gateway restart during the memory step ends the summary visibly", async (t) => {
  const x = await fixture(t);
  assert.deepEqual(await json(await x.summarise(), 200), running);
  await until(() => x.stepSends().length === 1, "the memory step");
  // The Gateway goes away; its run of the step is lost.
  x.gateway.client.ready = false;
  const attempt = x.assistants.ledger.attemptFor(
    x.assistants.ledger.requests(x.id).at(-1).id,
  );
  x.assistants.ledger.transition(attempt.id, "interrupted");
  await x.ended();
  assert.equal(x.compacted.length, 0);
  x.gateway.client.ready = true;
  const after = await x.history();
  assert.equal(after.compactOutcome, "interrupted");
  assert.equal(after.memoryNotSaved, true);
});

test("a message queued while memories are saved is sent once, after the summary", async (t) => {
  const x = await fixture(t);
  assert.deepEqual(await json(await x.summarise(), 200), running);
  await until(() => x.stepSends().length === 1, "the memory step");
  await json(
    await x.f.request(`${x.chat}/queued`, { method: "POST", body: { text: "Later" } }),
    200,
  );
  await x.endStep("ok");
  await until(() => x.otherSends().length === 1, "the queued message");
  await tick(80);
  assert.equal(x.otherSends().length, 1);
  assert.deepEqual(x.order(), ["sessions.send", "sessions.compact", "sessions.send"]);
  assert.equal((await x.history()).queued, null);
});

test("a later summary without a memory step drops the earlier note", async (t) => {
  const x = await fixture(t);
  await x.summarise();
  await x.endStep("error");
  await x.ended();
  assert.equal((await x.history()).memoryNotSaved, true);
  // The write guard is gone: the next summary runs without a step.
  x.assistants.config.writeGuard = () => false;
  assert.deepEqual(await json(await x.summarise(), 200), { compacted: true });
  assert.equal(x.stepSends().length, 1);
  assert.equal((await x.history()).memoryNotSaved, undefined);
});
