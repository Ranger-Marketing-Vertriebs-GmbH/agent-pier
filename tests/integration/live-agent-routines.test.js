import test from "node:test";
import assert from "node:assert/strict";
import { openLive } from "../helpers/live-socket.js";
import { chatFixture } from "../helpers/user-chats.js";

// `agent.routines:<id>` (AGENTPIER-445): the routine list pushes like the reminders,
// so "Run queued." goes once a run completes without reopening the settings.
const timeout = 20000;
const loaded = 10000;

async function subscribe(f, topic) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello", loaded);
  live.send({ op: "sub", topic });
  return { live, first: await live.next((frame) => frame.topic === topic, loaded) };
}

test(
  "agent.routines answers the route and pushes a new routine",
  { timeout },
  async (t) => {
    const { f } = await chatFixture(t);
    const assistant = f.application.assistants.store.createAssistant({
      name: "Routined",
      model: { connectionId: "c", modelId: "m" },
      capabilities: { memory: false, reminders: true },
    });
    const path = `/api/assistants/${assistant.id}/routines`;
    const topic = `agent.routines:${assistant.id}`;
    const { live, first } = await subscribe(f, topic);
    assert.equal(first.type, "snapshot");
    assert.deepEqual(first.data, await (await f.request(path)).json());
    const created = await f.request(path, {
      method: "POST",
      body: {
        clientRequestId: "live-routine",
        name: "Morning",
        prompt: "Sum up the news",
        trigger: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
      },
    });
    assert.equal(created.status, 201, await created.clone().text());
    const frame = await live.next(
      (frame) => frame.topic === topic && frame.data?.routines?.length === 1,
      2000,
    );
    assert.equal(frame.data.routines[0].name, "Morning");
    live.ws.close();
  },
);
