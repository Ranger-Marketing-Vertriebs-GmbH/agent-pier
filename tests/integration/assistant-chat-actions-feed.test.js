import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { applyChatSync } from "../../web/features/chat/chat-sync.js";

const timeout = 15000;

async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await delay(10);
  }
}

/** Two agents with one chat each; feed reads and change events are counted. */
async function fixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  assert.ok(service?.workflows, "the agent workflows run");
  service.feeds.debounceMs = 20;
  const agent = (name, key) => {
    const assistant = service.store.createAssistant({
      name,
      model: { connectionId: "c", modelId: "m" },
    });
    const conversation = service.store.saveConversation({
      assistantId: assistant.id,
      runtimeSessionKey: key,
    });
    return { id: assistant.id, conversation: conversation.id };
  };
  const one = agent("One", "agent:one:main");
  const two = agent("Two", "agent:two:main");
  const reads = new Map();
  const read = service.feeds.read;
  service.feeds.read = (id) => {
    reads.set(id, (reads.get(id) || 0) + 1);
    return read(id);
  };
  let changes = 0;
  const changed = service.changed.bind(service);
  service.changed = (options) => {
    changes++;
    return changed(options);
  };
  return Object.assign(f, { service, one, two, reads, changes: () => changes });
}

function connect(t, f, id) {
  const ws = new WebSocket(
    `${f.url.replace("http:", "ws:")}/api/assistant-conversations/${id}/stream`,
    { origin: f.url, headers: { cookie: f.cookie } },
  );
  const frames = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  ws.on("error", () => {});
  t.after(() => ws.terminate());
  const syncs = () => frames.filter((frame) => frame.type === "sync");
  let state = null;
  return {
    syncs,
    // The window after `count` sync frames, as the browser applies them.
    async window(count) {
      await until(() => syncs().length >= count, `sync ${count}`);
      for (const frame of syncs()
        .slice(0, count)
        .slice(state ? state.count : 0))
        state = {
          value: applyChatSync(state?.value, frame.data),
          count: (state?.count || 0) + 1,
        };
      return state.value;
    },
  };
}

const reserve = (f, agent, key) =>
  f.service.workflows.store.reserve({
    assistantId: agent.id,
    conversationId: agent.conversation,
    key,
    payload: { action: "memory_write", projectId: "p", title: "T", content: "Remember" },
    origin: { kind: "owner" },
    state: "awaiting_approval",
  });

test(
  "an open chat's pending actions arrive on its feed: one read for every socket",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const first = connect(t, f, f.one.conversation);
    const second = connect(t, f, f.one.conversation);
    const other = connect(t, f, f.two.conversation);
    assert.deepEqual((await first.window(1)).actions, []);
    assert.deepEqual((await second.window(1)).actions, []);
    await other.window(1);
    const before = {
      one: f.reads.get(f.one.conversation),
      two: f.reads.get(f.two.conversation),
    };
    const action = reserve(f, f.one, "memory-1");
    const created = await first.window(2);
    const mirrored = await second.window(2);
    assert.equal(second.syncs()[1].data.sync.mode, "delta");
    assert.deepEqual(
      mirrored.actions.map((a) => [a.id, a.state]),
      [[action.id, "awaiting_approval"]],
    );
    assert.equal(created.actions[0].payload.content, "Remember");
    // One shared read for both sockets; the other agent's chat is not read.
    assert.equal(f.reads.get(f.one.conversation), before.one + 1);
    await delay(80);
    assert.equal(f.reads.get(f.two.conversation), before.two);
    assert.equal(other.syncs().length, 1);
    // The owner's decision leaves the list on the same feed, without a global re-read.
    const response = await f.request(`/api/assistant-actions/${action.id}/decision`, {
      method: "POST",
      body: { revision: action.revision, decision: "decline" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await first.window(3)).actions, []);
    assert.deepEqual((await second.window(3)).actions, []);
    await delay(80);
    assert.equal(f.reads.get(f.two.conversation), before.two);
    assert.equal(other.syncs().length, 1);
  },
);

test(
  "a lead's chat shows a member's delegated request; idle passes change nothing",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const lead = connect(t, f, f.one.conversation);
    await lead.window(1);
    const delegated = f.service.workflows.store.reserve({
      assistantId: f.two.id,
      conversationId: f.two.conversation,
      key: "ssh-1",
      leadAssistantId: f.one.id,
      memberName: "Two",
      payload: { action: "ssh", command: "uptime", hostName: "h" },
      origin: { kind: "owner" },
      state: "awaiting_approval",
    });
    assert.deepEqual(
      (await lead.window(2)).actions.map((a) => a.id),
      [delegated.id],
    );
    // An expired request is closed by the next pass and leaves the lead's chat.
    f.service.workflows.store.patch(delegated.id, { expiresAt: Date.now() - 1 });
    await lead.window(3);
    await f.service.workflows.tick();
    const closed = await lead.window(4);
    assert.deepEqual(closed.actions, []);
    assert.equal(f.service.workflows.get(delegated.id).state, "expired");
    // A pass that writes nothing neither announces a change nor reads a feed.
    await f.service.workflows.tick();
    const reads = f.reads.get(f.one.conversation);
    const changes = f.changes();
    await f.service.workflows.tick();
    await f.service.workflows.tick();
    await delay(80);
    assert.equal(f.changes(), changes);
    assert.equal(f.reads.get(f.one.conversation), reads);
  },
);
