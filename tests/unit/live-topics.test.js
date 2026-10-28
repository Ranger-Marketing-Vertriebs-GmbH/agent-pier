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
  assert.equal(topicInfo("pipeline.run:r1").path("r1"), "/pipeline-runs/r1");
  assert.equal(topicInfo("pipeline.run:r1").interval, 5000);
  assert.equal(topicInfo("pipeline.run:r1").mode, "state");
  assert.equal(topicInfo("pipeline.run:r1").sampled, false);
  assert.equal(topicInfo("pipeline.queue:p1").path("p1"), "/pipeline-queue/p1");
  assert.equal(topicInfo("pipeline.queue:p1").interval, 3000);
  assert.equal(topicInfo("pipeline.queue:p1").sampled, false);
  assert.equal(topicInfo("pipeline.run"), null);
});

test("the run counts and lists name their REST routes; the signal has none", () => {
  assert.equal(topicInfo("pipeline.counts").path(), "/pipeline-run-counts");
  assert.equal(
    topicInfo("pipeline.counts:p 1").path("p 1"),
    "/pipeline-run-counts?projectId=p+1",
  );
  assert.equal(topicInfo("pipeline.counts:p1").interval, 30000);
  assert.equal(topicInfo("pipeline.counts:"), null);
  const list = topicInfo("pipeline.runs:p1:failed");
  assert.equal(list.mode, "state");
  assert.equal(list.interval, 5000);
  assert.equal(
    list.path("p1:failed"),
    "/pipeline-runs?view=list&page=1&projectId=p1&status=failed",
  );
  assert.equal(list.path("*:*"), "/pipeline-runs?view=list&page=1");
  assert.equal(list.path("*:running"), "/pipeline-runs?view=list&page=1&status=running");
  assert.equal(list.path("p1:*"), "/pipeline-runs?view=list&page=1&projectId=p1");
  assert.equal(topicInfo("pipeline.runs"), null);
  for (const id of ["pipeline.runs.changed", "pipeline.runs.changed:p1"]) {
    const signal = topicInfo(id);
    assert.equal(signal.mode, "signal");
    assert.equal(signal.path, null);
    assert.equal(signal.sampled, false);
  }
  assert.equal(topicInfo("pipeline.runs.changed:p1").param, "p1");
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

test("the menu-hint topics name their REST routes; the CLI-facing two are sampled", () => {
  const summary = topicInfo("settings.summary");
  assert.equal(summary.path(), "/settings/summary");
  assert.equal(summary.mode, "state");
  assert.equal(summary.sampled, false);
  const problems = topicInfo("connections.problems");
  assert.equal(problems.path(), "/connections/problems");
  assert.equal(problems.sampled, true);
  const updates = topicInfo("runtime.updates");
  assert.equal(updates.path(), "/assistant-runtime/updates");
  assert.equal(updates.sampled, true);
  // The start page's former poll of these sources.
  for (const info of [summary, problems, updates]) assert.equal(info.interval, 30000);
  assert.equal(topicInfo("settings.summary:x"), null);
});
