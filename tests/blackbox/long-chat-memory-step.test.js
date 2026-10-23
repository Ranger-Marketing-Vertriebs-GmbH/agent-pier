import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import {
  MemoryStep,
  memoryStepText,
} from "../../server/features/assistants/memory-step.js";

// AGENTPIER-194: Summarise now first runs the memory step (memory-step.js) where the
// agent may write its memory, then OpenClaw's `sessions.compact`. The chat shows
// "saving memories" meanwhile, takes no turn and queues a message; a step that saved
// nothing still summarises and the chat says so.

async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
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
    compacted,
    order,
  };
}

test("an agent that may write its memory saves it first, then summarises", async (t) => {
  const x = await fixture(t);
  const summarised = x.summarise();
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
  assert.deepEqual(await json(await summarised, 200), { compacted: true });
  assert.deepEqual(x.order(), ["sessions.send", "sessions.compact"]);
  const after = await x.history();
  assert.equal(after.compacting, false);
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
  const summarised = x.summarise();
  await x.endStep("error");
  assert.deepEqual(await json(await summarised, 200), { compacted: true });
  assert.deepEqual(x.order(), ["sessions.send", "sessions.compact"]);
  const after = await x.history();
  assert.equal(after.compacting, false);
  assert.equal(after.memoryNotSaved, true);
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
  assert.deepEqual(await json(await x.summarise(), 200), { compacted: true });
  assert.ok(x.gateway.calls.some((c) => c.method === "sessions.abort"));
  assert.deepEqual(x.order(), ["sessions.send", "sessions.compact"]);
  assert.equal((await x.history()).memoryNotSaved, true);
});

test("a timed-out step whose run does not end leaves the chat busy, not hanging", async (t) => {
  const x = await fixture(t, { step: { limitMs: 60, idleMs: 60 } });
  // The abort never ends the run.
  x.assistants.cancel = async () => {};
  const response = await x.summarise();
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "CHAT_BUSY");
  assert.equal(x.compacted.length, 0);
  const after = await x.history();
  assert.equal(after.compacting, false);
  assert.equal(after.memoryNotSaved, true);
});

test("a second click while memories are saved joins the running summary", async (t) => {
  const x = await fixture(t);
  const one = x.summarise();
  await until(() => x.stepSends().length === 1, "the memory step");
  const two = x.summarise();
  await tick(40);
  await x.endStep("ok");
  assert.equal((await one).status, 200);
  assert.equal((await two).status, 200);
  assert.equal(x.stepSends().length, 1);
  assert.equal(x.compacted.length, 1);
});

test("a Gateway restart during the memory step ends the summary visibly", async (t) => {
  const x = await fixture(t);
  const summarised = x.summarise();
  await until(() => x.stepSends().length === 1, "the memory step");
  // The Gateway goes away; its run of the step is lost.
  x.gateway.client.ready = false;
  const attempt = x.assistants.ledger.attemptFor(
    x.assistants.ledger.requests(x.id).at(-1).id,
  );
  x.assistants.ledger.transition(attempt.id, "interrupted");
  const response = await summarised;
  assert.equal(response.status, 503);
  assert.equal(x.compacted.length, 0);
  x.gateway.client.ready = true;
  const after = await x.history();
  assert.equal(after.compacting, false);
  assert.equal(after.memoryNotSaved, true);
});

test("a message queued while memories are saved is sent once, after the summary", async (t) => {
  const x = await fixture(t);
  const summarised = x.summarise();
  await until(() => x.stepSends().length === 1, "the memory step");
  await json(
    await x.f.request(`${x.chat}/queued`, { method: "POST", body: { text: "Later" } }),
    200,
  );
  await x.endStep("ok");
  assert.equal((await summarised).status, 200);
  await until(() => x.otherSends().length === 1, "the queued message");
  await tick(80);
  assert.equal(x.otherSends().length, 1);
  assert.deepEqual(x.order(), ["sessions.send", "sessions.compact", "sessions.send"]);
  assert.equal((await x.history()).queued, null);
});
