import test from "node:test";
import assert from "node:assert/strict";
import {
  forgetReminderSamples,
  sharedReminderJobs,
} from "../../server/features/users/reminder-samples.js";
import { agentRemindersChanged } from "../../server/features/assistants/live-topics.js";

// One Gateway read per agent and interval serves every user watching its reminders.
function setup() {
  let clock = 1000;
  const timers = new Map();
  let next = 0;
  const reads = [];
  const jobs = { a: [{ id: "j1" }], b: [{ id: "k1" }] };
  const shared = sharedReminderJobs(
    {},
    {
      readJobs: async (agentId) => {
        reads.push(agentId);
        if (!jobs[agentId]) throw new Error("gone");
        return jobs[agentId];
      },
      sampleMs: 30000,
      freshMs: 2000,
      now: () => clock,
      timers: {
        setInterval: (fn) => {
          timers.set(++next, fn);
          return next;
        },
        clearInterval: (id) => timers.delete(id),
      },
    },
  );
  const tick = async () => {
    for (const fn of [...timers.values()]) fn();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { shared, reads, jobs, timers, tick, advance: (ms) => (clock += ms) };
}

test("users watching one agent share one sample, and hear only changes", async () => {
  const { shared, reads, jobs, timers, tick, advance } = setup();
  const heard = [];
  const stops = [
    shared.watch("a", () => heard.push("anna")),
    shared.watch("a", () => heard.push("ben")),
  ];
  assert.equal(timers.size, 1);
  await tick();
  assert.deepEqual(reads, ["a"]);
  assert.deepEqual(heard, ["anna", "ben"]);
  // The reads it set off get the sample instead of asking the Gateway.
  assert.deepEqual(shared.sample("a").jobs, [{ id: "j1" }]);
  advance(2001);
  assert.equal(shared.sample("a"), undefined);
  // An unchanged sample sets off nothing; a changed one every watcher.
  await tick();
  assert.deepEqual(heard, ["anna", "ben"]);
  jobs.a = [{ id: "j1", state: { lastRunStatus: "ok" } }];
  await tick();
  assert.deepEqual(heard, ["anna", "ben", "anna", "ben"]);
  // A failed sample lets the users' reads answer with the refusal.
  delete jobs.a;
  await tick();
  assert.equal(shared.sample("a"), undefined);
  assert.equal(heard.length, 6);
  for (const stop of stops) stop();
  assert.equal(timers.size, 0);
});

test("the shared sample reads the agent's jobs under admission", async () => {
  const admitted = [];
  const reminders = {
    assistants: {
      admit: async (operation) => {
        admitted.push("admit");
        return operation();
      },
    },
    agent: (id) => ({ runtimeAgentId: `rt-${id}` }),
    jobs: async (agent) => [{ id: agent.runtimeAgentId }],
  };
  let tick;
  const shared = sharedReminderJobs(
    { assistantReminders: reminders },
    { timers: { setInterval: (fn) => (tick = fn), clearInterval: () => {} } },
  );
  const stop = shared.watch("a", () => {});
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shared.sample("a").jobs, [{ id: "rt-a" }]);
  assert.deepEqual(admitted, ["admit"]);
  stop();
});

test("a reminder write right after a sample makes the reads ask the Gateway", async () => {
  const { shared, tick } = setup();
  const stops = [shared.watch("a", () => {}), shared.watch("b", () => {})];
  await tick();
  const sampled = shared.sample("a");
  assert.ok(Number.isSafeInteger(sampled.readAt));
  // The write's signal drops that agent's sample; another agent's stays.
  agentRemindersChanged(null, ["a"]);
  assert.equal(shared.sample("a"), undefined);
  assert.deepEqual(shared.sample("b").jobs, [{ id: "k1" }]);
  // Every agent's, for a run result.
  forgetReminderSamples([]);
  assert.equal(shared.sample("b"), undefined);
  for (const stop of stops) stop();
});

test("a sample the Gateway answered after a write is not handed out", async () => {
  let release;
  let tick;
  const shared = sharedReminderJobs(
    {},
    {
      readJobs: () => new Promise((resolve) => (release = resolve)),
      timers: { setInterval: (fn) => (tick = fn), clearInterval: () => {} },
    },
  );
  const stop = shared.watch("a", () => {});
  tick();
  // The write lands while the Gateway is still answering the sample.
  forgetReminderSamples(["a"]);
  release([{ id: "before-write" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shared.sample("a"), undefined);
  stop();
});
