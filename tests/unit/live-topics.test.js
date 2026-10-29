import test from "node:test";
import assert from "node:assert/strict";
import { liveTopics, readTopicValue, topicInfo } from "../../web/lib/live/live-topics.js";
import { liveEnvironment } from "../../web/lib/live/live-environment.js";
import { userRoutes } from "../../server/http/route-access.js";
import { ME_TOPICS } from "../../server/features/users/live-me-topics.js";

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
      sections: null,
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

test("the operations and artifact topics name their routes at their former polls", () => {
  const job = topicInfo("job.operation:a-1");
  assert.equal(job.path(job.param), "/operations/jobs/a-1");
  assert.deepEqual([job.mode, job.interval, job.sampled], ["state", 1500, true]);
  assert.equal(topicInfo("job.operation"), null);
  const plan = topicInfo("operations.release-sessions:2.1.0-beta.1");
  assert.equal(
    plan.path(plan.param),
    "/operations/releases/cleanup/2.1.0-beta.1/sessions",
  );
  assert.deepEqual([plan.mode, plan.interval, plan.sampled], ["state", 3000, true]);
  const usage = topicInfo("artifacts.usage");
  assert.equal(usage.path(), "/artifacts/usage");
  assert.deepEqual([usage.mode, usage.interval, usage.sampled], ["state", 5000, false]);
  const changed = topicInfo("artifacts.changed");
  assert.deepEqual(
    [changed.mode, changed.path, changed.interval],
    ["signal", null, 5000],
  );
  assert.equal(topicInfo("artifacts.changed:x"), null);
  const projects = topicInfo("projects.changed");
  assert.deepEqual(
    [projects.mode, projects.path, projects.interval],
    ["signal", null, 30000],
  );
  assert.equal(topicInfo("projects.changed:x"), null);
});

test("the tool and REA job topics name their routes at their former polls", () => {
  const tool = topicInfo("job.tool:codex");
  assert.equal(tool.path(tool.param), "/tool-installations?tool=codex");
  assert.deepEqual([tool.mode, tool.interval, tool.sampled], ["state", 1500, false]);
  assert.equal(topicInfo("job.tool"), null);
  // The agent browser settings follow job.tool:chromium; there is no own kind.
  assert.equal(topicInfo("job.chromium:current"), null);
  // A running REA job is sampled on the server, so a hidden tab lets it go.
  const rea = topicInfo("job.rea:current");
  assert.equal(rea.path(rea.param), "/rea");
  assert.deepEqual([rea.mode, rea.interval, rea.sampled], ["state", 1000, true]);
  assert.equal(topicInfo("job.rea"), null);
});

test("the package, plugin, SSH, sign-in and reload topics name their routes", () => {
  const expected = [
    ["job.mcp-package:s 1", "/mcp-servers/s%201/package", 2000, false],
    ["job.plugins:local-codex", "/accounts/local-codex/plugins", 2000, false],
    ["job.ssh-tools:abc", "/sessions/abc/ssh-accesses", 1500, true],
    ["job.chatgpt-login:current", "/assistant-model-login/current", 1000, false],
    ["session.reload:abc", "/sessions/abc/reload", 1500, true],
  ];
  for (const [topic, path, interval, sampled] of expected) {
    const info = topicInfo(topic);
    assert.equal(info.path(info.param), path, topic);
    assert.deepEqual(
      [info.mode, info.interval, info.sampled],
      ["state", interval, sampled],
    );
    assert.equal(topicInfo(topic.slice(0, topic.indexOf(":"))), null, topic);
  }
});

test("the file-job topic names both scopes' routes; deliveries need a session", () => {
  const global = topicInfo("files.jobs:global");
  assert.equal(global.path(global.param), "/files/jobs");
  assert.deepEqual(
    [global.mode, global.interval, global.sampled],
    ["state", 1500, false],
  );
  const project = topicInfo("files.jobs:session:s 1");
  assert.equal(project.path(project.param), "/sessions/s%201/files/explorer/jobs");
  assert.equal(topicInfo("files.jobs"), null);
  const deliveries = topicInfo("session.deliveries:s1");
  assert.deepEqual(
    [deliveries.mode, deliveries.path, deliveries.interval, deliveries.param],
    ["signal", null, 2500, "s1"],
  );
  assert.equal(topicInfo("session.deliveries"), null);
});

test("the agent list names its route and reads the runtime from its own", async () => {
  const info = topicInfo("agent.list");
  assert.equal(info.mode, "rows");
  assert.equal(info.path(), "/assistants");
  assert.equal(info.sections.runtime(), "/assistant-runtime");
  assert.equal(info.interval, 5000);
  assert.equal(info.sampled, false);
  assert.equal(topicInfo("agent.list:x"), null);
  assert.equal(topicInfo("inbox").sections, null);
  const reads = [];
  const read = async (path) => {
    reads.push(path);
    return path === "/assistants" ? { assistants: [] } : { availability: "ready" };
  };
  assert.deepEqual(await readTopicValue(info.path(), info.sections, read), {
    assistants: [],
    runtime: { availability: "ready" },
  });
  assert.deepEqual(reads, ["/assistants", "/assistant-runtime"]);
  assert.deepEqual(await readTopicValue("/inbox", null, async () => ({ n: 1 })), {
    n: 1,
  });
  // One failed route fails the whole read.
  await assert.rejects(
    readTopicValue(info.path(), info.sections, async (path) => {
      if (path === "/assistant-runtime") throw new Error("down");
      return {};
    }),
    /down/,
  );
});

test("the agent detail topics name their routes at their former polls", () => {
  const routes = {
    "agent.actions": ["/assistants/a%2Fb/actions", 3000, false],
    "agent.coding-requests": ["/assistants/a%2Fb/actions", 3000, false],
    "agent.channels": ["/assistant-channels", 2000, false],
    "agent.reminders": ["/assistants/a%2Fb/reminders", 10000, true],
    "agent.senders": ["/assistant-telegram-senders/a%2Fb", 5000, true],
    // Pushed by every change of the agent's SSH agent; the fallback polls slowly.
    "agent.ssh-agent": ["/assistants/a%2Fb/ssh-agent", 30000, false],
  };
  for (const [name, [path, interval, sampled]] of Object.entries(routes)) {
    const info = topicInfo(`${name}:a/b`);
    assert.deepEqual(
      [info.mode, info.path(info.param), info.interval, info.sampled],
      ["state", path, interval, sampled],
      name,
    );
    // Each one is an agent's: the parameter is required.
    assert.equal(topicInfo(name), null, name);
  }
});

test("a user's me.* topics read her own /api/me routes, each the route it pushes", () => {
  const routed = userRoutes.filter((route) => route.topic);
  for (const name of ME_TOPICS) {
    const id = name === "me.agents" || name === "me.account" || name === "me.approvals";
    const topicId = id ? name : `${name}:agent-1`;
    const info = topicInfo(topicId);
    assert.ok(info, topicId);
    assert.equal(info.mode, "state");
    const route = routed.find((r) => r.topic.test(topicId));
    assert.match(`/api${info.path(info.param)}`, route.pattern, topicId);
  }
  assert.equal(topicInfo("me.reminders:a").sampled, true);
  assert.equal(topicInfo("me.chats"), null);
  assert.equal(topicInfo("me.agents:x"), null);
});

test("an editor document's file.meta topic needs its token and has no REST route", () => {
  const info = topicInfo(`file.meta:${"a".repeat(22)}`);
  assert.deepEqual(
    [info.mode, info.path, info.interval, info.sampled, info.param],
    ["state", null, 15000, false, "a".repeat(22)],
  );
  assert.equal(topicInfo("file.meta"), null);
  assert.equal(topicInfo("file.meta:"), null);
});

test("the AgentBus signal takes a project or none; the sign-in state is sampled", () => {
  const bus = topicInfo("agentbus.changed");
  assert.deepEqual(
    [bus.mode, bus.path, bus.interval, bus.sampled],
    ["signal", null, 10000, false],
  );
  assert.equal(topicInfo(`agentbus.changed:${"a".repeat(64)}`).param, "a".repeat(64));
  const auth = topicInfo("account.auth:local-codex");
  assert.deepEqual(
    [auth.mode, auth.path(auth.param), auth.interval, auth.sampled],
    ["state", "/accounts/local-codex/auth-status", 30000, true],
  );
  assert.equal(topicInfo("account.auth"), null);
});
