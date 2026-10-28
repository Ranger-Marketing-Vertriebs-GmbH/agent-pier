import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { signedInUser } from "../helpers/users.js";
import { chatFixture } from "../helpers/user-chats.js";
import {
  AGENT_DETAIL_TOPICS,
  agentActionsChanged,
  agentRunChanged,
  followReminderWrites,
} from "../../server/features/assistants/live-topics.js";
import { retireReleased } from "../../server/features/users/user-release.js";

const timeout = 20000;

function errorsOf(t) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return errors;
}

/** An app with the agent feature on and one agent; `gateway` fakes the Gateway. */
async function fixture(t, { gateway = false } = {}) {
  const made = gateway
    ? await chatFixture(t)
    : { f: await applicationFixture(t, enabledAssistants) };
  const f = made.f;
  const service = f.application.assistants;
  const assistant = service.store.createAssistant({
    name: "Detailed",
    model: { connectionId: "c", modelId: "m" },
    capabilities: { memory: false, reminders: true },
  });
  return Object.assign(f, { service, assistant, gateway: made.gateway });
}

async function subscribe(f, topic, cookie) {
  const live = openLive(f, cookie);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic });
  return { live, first: await live.next((frame) => frame.topic === topic, 5000) };
}

const json = async (f, path) => (await f.request(path)).json();

let keys = 0;
const reserve = (f, values = {}) =>
  f.service.workflows.store.reserve({
    assistantId: f.assistant.id,
    key: `live-topic:${++keys}`,
    payload: { action: "coding_start", projectId: "p", pipelineId: "x" },
    origin: { kind: "owner" },
    state: "awaiting_approval",
    ...values,
  });

test("the five agent detail topics are owner topics with an agent parameter", () => {
  assert.deepEqual(AGENT_DETAIL_TOPICS, [
    "agent.actions",
    "agent.coding-requests",
    "agent.channels",
    "agent.reminders",
    "agent.senders",
  ]);
});

test(
  "agent.actions answers the route and pushes every action write",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    reserve(f);
    const topic = `agent.actions:${f.assistant.id}`;
    const { live, first } = await subscribe(f, topic);
    assert.equal(first.type, "snapshot");
    assert.deepEqual(
      first.data,
      await json(f, `/api/assistants/${f.assistant.id}/actions`),
    );
    const started = Date.now();
    const second = reserve(f);
    const frame = await live.next((frame) => frame.topic === topic, 1000);
    assert.ok(Date.now() - started < 1000);
    assert.ok(frame.data.actions.some((a) => a.id === second.id));
    // A patch changes the digest too: an action's state is pushed.
    f.service.workflows.store.patch(second.id, { state: "declined" });
    const patched = await live.next((frame) => frame.topic === topic, 1000);
    assert.equal(patched.data.actions.find((a) => a.id === second.id).state, "declined");
    live.ws.close();
  },
);

test("agent.coding-requests carries the team requests only", { timeout }, async (t) => {
  const f = await fixture(t);
  reserve(f);
  const team = reserve(f, { teamId: "team-1" });
  const topic = `agent.coding-requests:${f.assistant.id}`;
  const { live, first } = await subscribe(f, topic);
  assert.equal(first.type, "snapshot");
  const rest = await json(f, `/api/assistants/${f.assistant.id}/actions`);
  assert.deepEqual(first.data, { actions: rest.actions.filter((a) => a.teamId) });
  assert.deepEqual(
    first.data.actions.map((a) => a.id),
    [team.id],
  );
  // An action of the agent's own changes nothing here.
  reserve(f);
  await assert.rejects(
    live.next((frame) => frame.topic === topic, 600),
    /no matching frame/,
  );
  f.service.workflows.store.patch(team.id, { state: "approved" });
  // Not a latency check (the actions test has one): room for a loaded machine.
  const frame = await live.next((frame) => frame.topic === topic, 3000);
  assert.equal(frame.data.actions[0].state, "approved");
  live.ws.close();
});

test("a run of an agent's action signals that agent's action topics", async (t) => {
  const f = await fixture(t);
  const other = f.service.store.createAssistant({
    name: "Other",
    model: { connectionId: "c", modelId: "m" },
  });
  reserve(f, { runId: "run-1", run: { status: "running" } });
  const invalidated = [];
  const hub = {
    named: (name) => (name === "agent.actions" ? [{}] : []),
    invalidate: (name, param) => invalidated.push(`${name}:${param}`),
  };
  agentRunChanged({ live: hub, assistants: f.service }, "run-1");
  assert.deepEqual(invalidated, [
    `agent.actions:${f.assistant.id}`,
    `agent.coding-requests:${f.assistant.id}`,
  ]);
  invalidated.length = 0;
  agentRunChanged({ live: hub, assistants: f.service }, "run-unknown");
  assert.deepEqual(invalidated, []);
  // Nobody watches: no lookup at all.
  let looked = false;
  agentRunChanged(
    {
      live: { named: () => [], invalidate: () => invalidated.push("x") },
      assistants: {
        workflows: {
          store: {
            agentsOfRun: () => {
              looked = true;
              return [other.id];
            },
          },
        },
      },
    },
    "run-1",
  );
  assert.equal(looked, false);
  assert.deepEqual(invalidated, []);
});

test("a failing change hook is logged; the write stands", async (t) => {
  const f = await fixture(t);
  const errors = errorsOf(t);
  agentActionsChanged(
    {
      invalidate: () => {
        throw new Error("boom");
      },
    },
    [f.assistant.id],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /could not report a change of the agent actions/);
  // The store's own hook reports through the same function.
  const hub = f.application.live;
  const invalidate = hub.invalidate;
  t.after(() => {
    hub.invalidate = invalidate;
  });
  hub.invalidate = () => {
    throw new Error("boom");
  };
  const action = reserve(f);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.service.workflows.store.get(action.id).id, action.id);
  assert.equal(errors.length, 2);
});

function channelOf(f, assistantId, botId) {
  const conversation = f.service.store.saveConversation({
    assistantId,
    runtimeSessionKey: `agent:${assistantId}:main`,
  });
  return f.application.assistantChannels.store.create({
    assistantId,
    conversationId: conversation.id,
    botId,
    username: `agent_bot_${botId}`,
    token: `${botId}:token`,
  });
}

test(
  "agent.channels answers the agent's channels and pushes store writes",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const other = f.service.store.createAssistant({
      name: "Other",
      model: { connectionId: "c", modelId: "m" },
    });
    const channel = channelOf(f, f.assistant.id, 101);
    channelOf(f, other.id, 102);
    const topic = `agent.channels:${f.assistant.id}`;
    const { live, first } = await subscribe(f, topic);
    assert.equal(first.type, "snapshot");
    const rest = await json(f, "/api/assistant-channels");
    assert.equal(rest.channels.length, 2);
    assert.deepEqual(first.data, {
      ...rest,
      channels: rest.channels.filter((c) => c.assistantId === f.assistant.id),
    });
    // A write that announces nothing else (a poll diagnostic) is pushed.
    f.application.assistantChannels.store.diagnostic(channel.id, "TELEGRAM_UNAVAILABLE");
    const frame = await live.next((frame) => frame.topic === topic, 1000);
    assert.equal(frame.data.channels[0].diagnostic, "TELEGRAM_UNAVAILABLE");
    live.ws.close();
  },
);

test(
  "agent.reminders answers the route and pushes a new reminder",
  { timeout },
  async (t) => {
    const f = await fixture(t, { gateway: true });
    const path = `/api/assistants/${f.assistant.id}/reminders`;
    const topic = `agent.reminders:${f.assistant.id}`;
    const { live, first } = await subscribe(f, topic);
    assert.equal(first.type, "snapshot");
    assert.deepEqual(first.data, await json(f, path));
    const created = await f.request(path, {
      method: "POST",
      body: {
        clientRequestId: "live-reminder",
        name: "Water",
        message: "Water the plants",
        schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
      },
    });
    assert.equal(created.status, 201, await created.clone().text());
    const frame = await live.next(
      (frame) => frame.topic === topic && frame.data?.reminders?.length === 1,
      2000,
    );
    assert.deepEqual(frame.data, await json(f, path));
    live.ws.close();
  },
);

test(
  "agent.senders answers the route and samples the Gateway's bot state",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const topic = `agent.senders:${f.assistant.id}`;
    const { live, first } = await subscribe(f, topic);
    assert.equal(first.type, "snapshot");
    assert.deepEqual(
      first.data,
      await json(f, `/api/assistant-telegram-senders/${f.assistant.id}`),
    );
    const definition = f.application.live.topics.get("agent.senders").definition;
    assert.ok(definition.sampleMs > 0 && definition.sampleMs <= 5000);
    live.ws.close();
  },
);

test(
  "without agent services every detail topic refuses like its route, unlogged",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const errors = errorsOf(t);
    const id = f.assistant.id;
    const off = await f.request("/api/assistant-feature", {
      method: "PUT",
      body: { enabled: false },
    });
    assert.equal(off.status, 200);
    assert.equal((await f.request(`/api/assistants/${id}/actions`)).status, 404);
    for (const name of AGENT_DETAIL_TOPICS) {
      const topic = `${name}:${id}`;
      const { live, first } = await subscribe(f, topic);
      assert.deepEqual(first, { type: "error", topic }, topic);
      live.ws.close();
    }
    assert.deepEqual(
      errors.filter((line) => line.includes("live topic")),
      [],
    );
  },
);

test(
  "an unknown agent refuses like the routes' 404, unlogged",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const errors = errorsOf(t);
    for (const name of AGENT_DETAIL_TOPICS) {
      const topic = `${name}:nobody`;
      const { live, first } = await subscribe(f, topic);
      assert.deepEqual(first, { type: "error", topic }, topic);
      live.ws.close();
    }
    assert.deepEqual(
      errors.filter((line) => line.includes("live topic")),
      [],
    );
  },
);

test(
  "a restricted user cannot subscribe to any agent detail topic",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const { cookie } = await signedInUser(f);
    for (const name of AGENT_DETAIL_TOPICS) {
      const topic = `${name}:${f.assistant.id}`;
      const { live, first } = await subscribe(f, topic, cookie);
      assert.deepEqual(first, { type: "error", topic, code: "unknown-topic" });
      live.ws.close();
    }
  },
);

test(
  "a change made in the Gateway alone reaches agent.reminders by sampling",
  { timeout },
  async (t) => {
    const f = await fixture(t, { gateway: true });
    const path = `/api/assistants/${f.assistant.id}/reminders`;
    const created = await f.request(path, {
      method: "POST",
      body: {
        clientRequestId: "sampled-reminder",
        name: "Water",
        message: "Water the plants",
        schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
      },
    });
    assert.equal(created.status, 201);
    const topic = `agent.reminders:${f.assistant.id}`;
    const { live, first } = await subscribe(f, topic);
    assert.equal(first.data.reminders[0].name, "Water");
    assert.equal(
      f.application.live.topics.get("agent.reminders").definition.sampleMs,
      30000,
    );
    // The agent's own cron tool renames the job: AgentPier hears nothing of it.
    const [job] = f.gateway.jobs.values();
    f.gateway.jobs.set(job.id, { ...job, name: "Water the garden", updatedAtMs: 3 });
    f.application.live.nudge("agent.reminders");
    const frame = await live.next((frame) => frame.topic === topic, 2000);
    assert.equal(frame.data.reminders[0].name, "Water the garden");
    live.ws.close();
  },
);

test("reminder writes signal their agent, a run result every agent", async (t) => {
  const errors = errorsOf(t);
  const signals = [];
  let failing = false;
  const hub = {
    invalidate: (name, id) => {
      if (failing) throw new Error("boom");
      signals.push(`${name}:${id ?? "*"}`);
    },
  };
  const reminders = {
    create: async (id) => ({ id }),
    remove: async () => {
      throw new Error("refused");
    },
    complete: async () => {},
    list: async () => ({ reminders: [] }),
  };
  followReminderWrites(reminders, () => hub);
  assert.deepEqual(await reminders.create("a1", {}), { id: "a1" });
  await assert.rejects(reminders.remove("a2", "b"), /refused/);
  await reminders.complete("binding", {});
  await reminders.list("a3");
  await new Promise((resolve) => setImmediate(resolve));
  // A failed write may have changed the job half way: it signals too.
  assert.deepEqual(signals, [
    "agent.reminders:a1",
    "agent.reminders:a2",
    "agent.reminders:*",
  ]);
  failing = true;
  await reminders.create("a4");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [
    "AgentPier could not report a change of the agent reminders.",
  ]);
});

test("exactly the topics that read through owner privacy are reset by it", async (t) => {
  const f = await fixture(t);
  const scoped = [...f.application.live.topics.values()]
    .filter(({ definition }) => definition.privacy === true)
    .map(({ definition }) => definition.name)
    .sort();
  assert.deepEqual(scoped, [
    "agent.actions",
    "agent.channels",
    "agent.coding-requests",
    "agent.list",
    "agent.reminders",
  ]);
});

test("a user's released reminders signal their agents' reminder topics", async () => {
  const signals = [];
  const live = { invalidate: (name, id) => signals.push(`${name}:${id}`) };
  const assistants = {
    reminders: { bindings: { list: () => [] } },
    store: { listAssistants: () => [{ id: "a" }, { id: "b" }] },
    admit: async (operation) => operation(),
    runtime: { client: { ready: false } },
    changed() {},
  };
  await retireReleased({ assistants, live }, [{ id: "a" }]);
  assert.deepEqual(signals, ["agent.reminders:a"]);
});
