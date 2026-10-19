import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { applyListSync } from "../../web/features/assistants/agent-list-sync.js";

const timeout = 15000;

async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await delay(10);
  }
}

/** An app with the agent feature on, no Gateway, one agent, counting list reads. */
async function fixture(t) {
  const f = await applicationFixture(t, enabledAssistants);
  const service = f.application.assistants;
  assert.ok(service, "the agent feature runs");
  service.listFeed.debounceMs = 20;
  const assistant = service.store.createAssistant({
    name: "Listed",
    model: { connectionId: "c", modelId: "m" },
  });
  let reads = 0;
  const read = service.listFeed.read;
  service.listFeed.read = () => {
    reads++;
    return read();
  };
  const rename = (name) =>
    service.store.updateAssistant(
      assistant.id,
      { name },
      service.store.getAssistant(assistant.id).revision,
    );
  return Object.assign(f, { service, assistant, rename, reads: () => reads });
}

/** Reads /api/assistant-events as server-sent events: [{id, event}]. */
function listen(t, f, { headers = {}, query = "" } = {}) {
  const controller = new AbortController();
  const events = [];
  const response = fetch(`${f.url}/api/assistant-events${query}`, {
    headers: { cookie: f.cookie, ...headers },
    signal: controller.signal,
  });
  const done = response.then(async (res) => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const id = /^id: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) events.push({ id, event: JSON.parse(data) });
        }
      }
    } catch {
      /* Aborted. */
    }
  });
  const close = () => controller.abort();
  t.after(close);
  const syncs = () => events.filter((e) => e.event.type === "sync");
  return { events, syncs, close, done, response };
}

test(
  "the event stream sends the agent list whole, then as deltas from one shared read",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const one = listen(t, f);
    const two = listen(t, f);
    await until(() => one.syncs().length && two.syncs().length, "initial lists");
    assert.deepEqual(one.events[0].event, { type: "connected", list: true });
    assert.equal(f.reads(), 1, "one read serves both streams");
    const [first] = one.syncs();
    assert.equal(first.event.data.sync.mode, "full");
    assert.equal(first.id, first.event.data.sync.cursor);
    let held = applyListSync(null, first.event.data);
    assert.deepEqual(
      held.list.assistants.map((a) => a.name),
      ["Listed"],
    );
    assert.equal(held.list.runtime.availability, f.service.runtime.status().availability);

    // A burst of changes reads once and sends one delta.
    f.rename("Renamed");
    for (let i = 0; i < 5; i++) f.service.changed();
    await until(() => one.syncs().length === 2 && two.syncs().length === 2, "delta");
    assert.equal(f.reads(), 2);
    const delta = one.syncs()[1].event.data;
    assert.equal(delta.sync.mode, "delta");
    assert.ok(delta.upserts.some((row) => row.id === `assistants/${f.assistant.id}`));
    held = applyListSync(held, delta);
    assert.equal(held.list.assistants[0].name, "Renamed");

    // A change event that changes nothing reads once and sends nothing.
    f.service.changed();
    await until(() => f.reads() === 3, "recompute");
    await delay(60);
    assert.equal(one.syncs().length, 2);
    assert.ok(one.events.filter((e) => e.event.type === "change").length >= 2);

    // A reconnect resumes from the last event id.
    one.close();
    f.rename("Again");
    f.service.changed();
    const back = listen(t, f, { headers: { "Last-Event-ID": held.state.sync.cursor } });
    await until(
      () => back.syncs().some((e) => e.event.data.upserts?.length),
      "resumed delta",
    );
    for (const { event } of back.syncs()) {
      assert.equal(event.data.sync.mode, "delta");
      held = applyListSync(held, event.data);
    }
    assert.equal(held.list.assistants[0].name, "Again");

    // So does the cursor query; an unknown cursor gets the whole list.
    const query = listen(t, f, {
      query: `?cursor=${encodeURIComponent(held.state.sync.cursor)}`,
    });
    const stranger = listen(t, f, {
      headers: { "Last-Event-ID": "00000000-0000-0000-0000-000000000000" },
    });
    await until(() => query.syncs().length && stranger.syncs().length, "resume");
    assert.equal(query.syncs()[0].event.data.sync.mode, "delta");
    assert.equal(stranger.syncs()[0].event.data.sync.mode, "full");
  },
);

test(
  "the list feed is behind the login like the event stream",
  { timeout },
  async (t) => {
    const f = await fixture(t);
    const response = await fetch(`${f.url}/api/assistant-events`);
    assert.equal(response.status, 401);
    await response.body?.cancel();
    await delay(60);
    assert.equal(f.reads(), 0, "nothing is read for a refused stream");
  },
);
