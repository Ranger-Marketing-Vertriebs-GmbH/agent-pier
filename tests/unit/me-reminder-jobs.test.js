import test from "node:test";
import assert from "node:assert/strict";
import { sharedReminderJobs } from "../../server/features/users/live-me-topics.js";

// One Gateway read per agent and interval serves every user watching its reminders.
function setup() {
  let clock = 1000;
  const timers = new Map();
  let next = 0;
  const reads = [];
  const jobs = { a: [{ id: "j1" }], b: [{ id: "k1" }] };
  const services = {
    assistantReminders: {
      agentJobs: async (agentId) => {
        reads.push(agentId);
        if (!jobs[agentId]) throw new Error("gone");
        return jobs[agentId];
      },
    },
  };
  const shared = sharedReminderJobs(services, {
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
  });
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
  assert.deepEqual(shared.jobs("a"), [{ id: "j1" }]);
  advance(2001);
  assert.equal(shared.jobs("a"), undefined);
  // An unchanged sample sets off nothing; a changed one every watcher.
  await tick();
  assert.deepEqual(heard, ["anna", "ben"]);
  jobs.a = [{ id: "j1", state: { lastRunStatus: "ok" } }];
  await tick();
  assert.deepEqual(heard, ["anna", "ben", "anna", "ben"]);
  // A failed sample lets the users' reads answer with the refusal.
  delete jobs.a;
  await tick();
  assert.equal(shared.jobs("a"), undefined);
  assert.equal(heard.length, 6);
  for (const stop of stops) stop();
  assert.equal(timers.size, 0);
});
