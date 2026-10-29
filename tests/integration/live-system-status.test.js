import os from "node:os";
import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { manualTimers } from "../helpers/manual-timers.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { StorageCleanup } from "../../server/features/system-status/storage-cleanup.js";
import {
  SYSTEM_STATUS_SAMPLE_MS,
  cleanupSummaryTopic,
  systemStatusTopics,
} from "../../server/features/system-status/live-topics.js";

const owner = { role: "owner" };

// A status service whose figures the test sets; `reads` counts the calls.
function statusService() {
  const service = {
    summary: { cpu: { percent: 10 } },
    details: { cpu: { percent: 10 }, processes: [] },
    reads: { summary: 0, details: 0 },
  };
  service.readSummary = () => {
    service.reads.summary += 1;
    return structuredClone(service.summary);
  };
  return {
    service,
    services: {
      systemStatus: {
        summary: service.readSummary,
        details: () => {
          service.reads.details += 1;
          return structuredClone(service.details);
        },
      },
    },
  };
}

function hubOf(t, services) {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  for (const topic of systemStatusTopics(services)) hub.define(topic);
  return { clock, hub };
}

const listen = (hub, topic, principal = owner) => {
  const frames = [];
  const stop = hub.subscribe(principal, topic, undefined, (frame) => frames.push(frame));
  return { frames, stop };
};

test("each topic is sampled every 5 s, only while someone subscribes", async (t) => {
  assert.equal(SYSTEM_STATUS_SAMPLE_MS, 5000);
  const { service, services } = statusService();
  const { clock, hub } = hubOf(t, services);
  await clock.advance(60000);
  assert.deepEqual(service.reads, { summary: 0, details: 0 });
  const { frames, stop } = listen(hub, "system.status");
  await clock.advance(0);
  assert.equal(service.reads.summary, 1);
  assert.deepEqual(frames[0].data, { cpu: { percent: 10 } });
  // An unchanged sample sends nothing.
  await clock.advance(5000);
  assert.equal(service.reads.summary, 2);
  assert.equal(frames.length, 1);
  // Any change of the figures is a push.
  service.summary = { cpu: { percent: 11 } };
  await clock.advance(5000);
  assert.equal(frames.at(-1).type, "state");
  assert.deepEqual(frames.at(-1).data, { cpu: { percent: 11 } });
  // The details are read only for a subscriber of their own.
  assert.equal(service.reads.details, 0);
  stop();
  await clock.advance(600000);
  assert.equal(service.reads.summary, 3);
});

test("the details topic samples the details route's value", async (t) => {
  const { service, services } = statusService();
  const { clock, hub } = hubOf(t, services);
  const { frames, stop } = listen(hub, "system.status.details");
  await clock.advance(0);
  assert.deepEqual(frames[0].data, service.details);
  service.details = { ...service.details, processes: [{ id: "a" }] };
  await clock.advance(5000);
  assert.deepEqual(frames.at(-1).data.processes, [{ id: "a" }]);
  assert.equal(service.reads.summary, 0);
  stop();
});

test("only the owner may watch the topics", () => {
  const { services } = statusService();
  for (const topic of systemStatusTopics(services)) {
    assert.equal(topic.authorize({ role: "owner" }), true, topic.name);
    assert.equal(topic.authorize({ role: "user", userId: "u1" }), false, topic.name);
    assert.equal(topic.authorize(null), false, topic.name);
  }
});

test("a snapshot is the figures of the REST route, with session ids only", async (t) => {
  const f = await applicationFixture(t);
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  for (const [topic, path] of [
    ["system.status", "/api/system-status"],
    ["system.status.details", "/api/system-status/details"],
  ]) {
    live.send({ op: "sub", topic });
    const frame = await live.next((candidate) => candidate.topic === topic, 5000);
    assert.equal(frame.type, "snapshot", topic);
    const route = await (await f.request(path)).json();
    assert.deepEqual(Object.keys(frame.data).sort(), Object.keys(route).sort(), topic);
    for (const item of frame.data.sessions || [])
      assert.deepEqual(Object.keys(item).sort(), ["cpuPercent", "id", "rssBytes"]);
  }
  live.ws.close();
});

// A cleanup summary whose measurement the test settles by hand.
function cleanupFixture() {
  const runs = [];
  const storageCleanup = new StorageCleanup({
    dataDir: os.tmpdir(),
    services: {},
    audit: null,
  });
  storageCleanup.summaryMeasure.measure = () =>
    new Promise((resolve) => runs.push(resolve));
  return { storageCleanup, runs };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the cleanup summary topic pushes measuring, measured and a deletion's remeasure", async (t) => {
  const { storageCleanup, runs } = cleanupFixture();
  const { clock, hub } = hubOf(t, {});
  hub.define(cleanupSummaryTopic({ storageCleanup }));
  const { frames, stop } = listen(hub, "system.cleanup.summary");
  await clock.advance(0);
  assert.deepEqual(frames.at(-1).data, { state: "pending" });
  runs[0]({ bytes: 5 });
  await settle();
  await clock.advance(1000);
  assert.deepEqual(frames.at(-1).data, { state: "ready", bytes: 5 });
  assert.deepEqual(frames.at(-1).data, storageCleanup.summary());
  // A deletion invalidates the cache: the dialog sees it measured again.
  storageCleanup.summaryMeasure.invalidate();
  await clock.advance(1000);
  assert.equal(frames.at(-1).data.state, "refreshing");
  runs[1]({ bytes: 2 });
  await settle();
  await clock.advance(1000);
  assert.deepEqual(frames.at(-1).data, { state: "ready", bytes: 2 });
  const count = frames.length;
  await clock.advance(600000);
  assert.equal(frames.length, count, "nothing is sampled");
  stop();
  assert.equal(storageCleanup.events.listenerCount("change"), 0);
});

test("the cleanup summary topic is owner only", () => {
  const topic = cleanupSummaryTopic({ storageCleanup: cleanupFixture().storageCleanup });
  assert.equal(topic.authorize({ role: "owner" }), true);
  assert.equal(topic.authorize({ role: "user", userId: "u1" }), false);
  assert.equal(topic.authorize(null), false);
});
