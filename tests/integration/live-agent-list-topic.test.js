import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { signedInUser } from "../helpers/users.js";
import { applyListSync } from "../../web/lib/live/list-sync.js";
import { agentListTopic } from "../../server/features/assistants/live-topics.js";

const timeout = 20000;
const forList = (frame) => frame.topic === "agent.list";

function errorsOf(t) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return errors;
}

/** An app with the agent feature on (no Gateway) and one agent. */
async function fixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  assert.ok(service, "the agent feature runs");
  const assistant = service.store.createAssistant({
    name: "Listed",
    model: { connectionId: "c", modelId: "m" },
  });
  return Object.assign(f, { service, assistant });
}

const rename = (service, id, name) => {
  service.store.updateAssistant(id, { name }, service.store.getAssistant(id).revision);
  service.changed();
};

async function subscribed(f) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "agent.list" });
  return { live, first: await live.next(forList, 5000) };
}

// What /api/assistant-events sent as its list before the live channel: the
// GET /api/assistants body plus `runtime`, the GET /api/assistant-runtime answer.
async function restList(f) {
  const list = await (await f.request("/api/assistants")).json();
  const runtime = await (await f.request("/api/assistant-runtime")).json();
  return { ...list, runtime };
}

test("the agent list snapshot equals the former feed's list", { timeout }, async (t) => {
  const f = await fixture(t);
  const { live, first } = await subscribed(f);
  assert.equal(first.type, "snapshot");
  assert.equal(first.data.sync.mode, "full");
  const held = applyListSync(null, first.data);
  assert.deepEqual(held.list, await restList(f));
  assert.deepEqual(
    held.list.assistants.map((a) => a.name),
    ["Listed"],
  );
  live.ws.close();
});

test("an agent change pushes a delta within 1 s", { timeout }, async (t) => {
  const f = await fixture(t);
  const { live, first } = await subscribed(f);
  let held = applyListSync(null, first.data);
  const started = Date.now();
  rename(f.service, f.assistant.id, "Renamed");
  const frame = await live.next(forList, 1000);
  assert.ok(Date.now() - started < 1000);
  assert.equal(frame.type, "delta");
  assert.ok(frame.data.upserts.some((row) => row.id === `assistants/${f.assistant.id}`));
  held = applyListSync(held, frame.data);
  assert.equal(held.list.assistants[0].name, "Renamed");
  // A change that changes nothing sends nothing.
  f.service.changed();
  await assert.rejects(live.next(forList, 600), /no matching frame/);
  live.ws.close();
});

const switchAgents = async (f, enabled) => {
  const response = await f.request("/api/assistant-feature", {
    method: "PUT",
    body: { enabled },
  });
  assert.equal(response.status, 200);
};

test(
  "agents switched off and on again push the new services' changes",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const errors = errorsOf(t);
    const { live, first } = await subscribed(f);
    assert.equal(first.type, "snapshot");
    await switchAgents(f, false);
    assert.equal(f.application.assistants, null);
    await switchAgents(f, true);
    const service = f.application.assistants;
    assert.ok(service && service !== f.service, "new agent services");
    // The read the switch asked for settles first (maxWait 1 s) ...
    await delay(1200);
    // ... so only the new services' own change event can carry this rename.
    rename(service, f.assistant.id, "Back");
    const frame = await live.next(
      (frame) =>
        forList(frame) && frame.data?.upserts?.some((row) => row.value?.name === "Back"),
      2000,
    );
    assert.equal(frame.type, "delta");
    assert.deepEqual(
      errors.filter((line) => line.includes("live topic")),
      [],
    );
    live.ws.close();
  },
);

test(
  "while agents are off the list refuses expectedly; on again it answers",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const errors = errorsOf(t);
    await switchAgents(f, false);
    assert.equal((await f.request("/api/assistants")).status, 404);
    const { live, first } = await subscribed(f);
    // An error without a code: the client reads the route once and shows its 404.
    assert.deepEqual(first, { type: "error", topic: "agent.list" });
    await switchAgents(f, true);
    const answered = await live.next(forList, 5000);
    assert.equal(answered.type, "snapshot");
    assert.deepEqual(applyListSync(null, answered.data).list, await restList(f));
    assert.deepEqual(
      errors.filter((line) => line.includes("live topic")),
      [],
    );
    live.ws.close();
  },
);

test("a restricted user cannot subscribe to the agent list", { timeout }, async (t) => {
  const f = await fixture(t);
  const { cookie } = await signedInUser(f);
  const live = openLive(f, cookie);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "agent.list" });
  assert.deepEqual(await live.next(forList), {
    type: "error",
    topic: "agent.list",
    code: "unknown-topic",
  });
  live.ws.close();
});

test("without agent services the topic refuses with the route's status, expected", async () => {
  const owner = { role: "owner" };
  const off = agentListTopic({ assistants: null });
  assert.throws(
    () => off.read(owner),
    (error) => error.status === 404 && error.expected === true,
  );
  const down = agentListTopic({ assistantFeature: { enabled: true }, assistants: null });
  assert.throws(
    () => down.read(owner),
    (error) => error.status === 503 && error.expected === true,
  );
});
