import test from "node:test";
import assert from "node:assert/strict";
import { liveTopics, topicInfo } from "../../web/lib/live/live-topics.js";
import { liveEnvironment } from "../../web/lib/live/live-environment.js";

test("topicInfo resolves registered topics and their REST path", () => {
  const requests = topicInfo("session.requests:abc");
  assert.equal(requests.path("abc"), "/sessions/abc/requests");
  assert.deepEqual(
    { ...requests, path: undefined },
    {
      name: "session.requests",
      param: "abc",
      mode: "state",
      path: undefined,
      interval: 1500,
      sampled: true,
    },
  );
  assert.equal(topicInfo("x"), null);
  assert.equal(topicInfo("state").mode, "rows");
  assert.equal(topicInfo("state").path(), "/state");
  assert.equal(topicInfo("state").interval, 3000);
  assert.equal(topicInfo("state").sampled, false);
  assert.equal(topicInfo("inbox").path(), "/inbox");
  assert.equal(topicInfo("inbox").interval, 5000);
  assert.equal(topicInfo("session.models:s1").path("s1"), "/sessions/s1/models");
  assert.equal(topicInfo("session.models:s1").sampled, true);
  assert.equal(topicInfo("session.models:s1").interval, 3000);
});

test("topicInfo refuses a missing or unexpected parameter", () => {
  assert.equal(topicInfo("session.models"), null);
  assert.equal(topicInfo("session.models:"), null);
  assert.equal(topicInfo("state:x"), null);
  assert.equal(topicInfo(""), null);
  assert.equal(topicInfo(null), null);
  assert.equal(topicInfo("toString"), null);
  assert.equal(topicInfo("session.requests:a/b").path("a/b"), "/sessions/a%2Fb/requests");
  assert.equal(topicInfo("session.requests:a:b").param, "a:b");
  assert.ok(Object.isFrozen(liveTopics));
});

test("the browser environment points at /api/live on the page's host", (t) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "location");
  t.after(() =>
    before
      ? Object.defineProperty(globalThis, "location", before)
      : delete globalThis.location,
  );
  for (const [protocol, scheme] of [
    ["https:", "wss:"],
    ["http:", "ws:"],
  ]) {
    Object.defineProperty(globalThis, "location", {
      value: { protocol, host: "pier.local:4380" },
      configurable: true,
    });
    const env = liveEnvironment();
    assert.equal(env.url, `${scheme}//pier.local:4380/api/live`);
    assert.equal(typeof env.setTimeout, "function");
    assert.ok(env.random() >= 0 && env.random() < 1);
  }
});
