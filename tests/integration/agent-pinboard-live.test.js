import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { signedInUser } from "../helpers/users.js";
import { userAgent } from "../helpers/user-chats.js";
import { AGENT_PINBOARD_SAMPLE_MS } from "../../server/features/assistants/live-topics.js";

const timeout = 30000;
const loaded = 10000;

async function fixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  const agent = service.store.createAssistant({
    name: "Writer",
    model: { connectionId: "c", modelId: "m" },
  });
  return Object.assign(f, { service, agent });
}

async function subscribe(f, topic, cookie) {
  const live = openLive(f, cookie);
  await live.next((frame) => frame.type === "hello", loaded);
  live.send({ op: "sub", topic });
  return { live, first: await live.next((frame) => frame.topic === topic, loaded) };
}

/** Pins `name` in the agent's workspace through the production store. */
function pin(f, name) {
  const { service, agent } = f;
  const workspace = path.join(service.attachments.config.workspaces, agent.id);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, name), "# Episode\n");
  const now = new Date().toISOString();
  const list = service.pinboard.store.createList(agent.id, { title: "Episodes" }, now);
  service.pinboard.store.pin(
    agent.id,
    list.id,
    {
      name,
      note: "",
      root: "workspace",
      path: name,
      admitConversationId: null,
      identity: null,
    },
    now,
  );
  // As AgentPinboard#invoke ends a write.
  service.pinboard.onChange(agent.id);
}

test("a pin pushes the agent's pinboard", { timeout }, async (t) => {
  const f = await fixture(t);
  const topic = `agent.pinboard:${f.agent.id}`;
  const { live, first } = await subscribe(f, topic);
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.data.lists, []);
  pin(f, "ep6.md");
  const frame = await live.next(
    (frame) => frame.topic === topic && frame.data?.lists?.length === 1,
    loaded,
  );
  assert.equal(frame.data.lists[0].entries[0].name, "ep6.md");
  // The topic carries what the route answers.
  const route = await (await f.request(`/api/assistants/${f.agent.id}/pinboard`)).json();
  assert.deepEqual(frame.data, route);
  live.ws.close();
});

test("the pinboard is sampled while a tab watches", { timeout }, async (t) => {
  const f = await fixture(t);
  const definition = f.application.live.topics.get("agent.pinboard").definition;
  assert.equal(definition.sampleMs, AGENT_PINBOARD_SAMPLE_MS);
  assert.equal(AGENT_PINBOARD_SAMPLE_MS, 30000);
  assert.equal(definition.mode, "state");
});

test(
  "a user's own agent's pinboard is refused without her opt-in",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const ben = await signedInUser(f, "Ben");
    const own = await userAgent(f, {
      mode: "own",
      members: [{ userId: ben.user.id, level: "extended" }],
    });
    const topic = `agent.pinboard:${own.id}`;
    const { live, first } = await subscribe(f, topic);
    assert.equal(first.type, "error");
    assert.equal(first.topic, topic);
    live.ws.close();
  },
);

test("a restricted user cannot subscribe", { timeout }, async (t) => {
  const f = await fixture(t);
  const { cookie } = await signedInUser(f);
  const topic = `agent.pinboard:${f.agent.id}`;
  const { live, first } = await subscribe(f, topic, cookie);
  assert.deepEqual(first, { type: "error", topic, code: "unknown-topic" });
  live.ws.close();
});
