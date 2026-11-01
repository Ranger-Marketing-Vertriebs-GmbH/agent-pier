import test from "node:test";
import assert from "node:assert/strict";
import { agentSshFixture } from "../helpers/agent-ssh-fixture.js";

// tick() settles after a pass that began after the call; callers share one follow-up.
test("concurrent tick() calls during a pass share exactly one extra pass", async (t) => {
  const { workflows } = await agentSshFixture(t);
  let calls = 0;
  const gates = [];
  workflows.advance = () => {
    calls += 1;
    return new Promise((resolve) => gates.push(resolve));
  };
  const first = workflows.tick();
  assert.equal(calls, 1);
  const waiters = Array.from({ length: 10 }, () => workflows.tick());
  assert.equal(new Set(waiters).size, 1);
  assert.equal(calls, 1);
  gates[0]();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  // Callers arriving while the follow-up runs get the next single follow-up.
  const next = Array.from({ length: 5 }, () => workflows.tick());
  assert.equal(new Set(next).size, 1);
  gates[1]();
  await Promise.all(waiters);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 3);
  gates[2]();
  await Promise.all(next);
  assert.equal(calls, 3);
  assert.equal(workflows.running, null);
});

test("a rejected pass still runs the shared follow-up and resets it", async (t) => {
  const { workflows } = await agentSshFixture(t);
  let calls = 0;
  const gates = [];
  workflows.advance = () => {
    calls += 1;
    return new Promise((resolve, reject) => gates.push({ resolve, reject }));
  };
  const first = workflows.tick();
  const waiters = Array.from({ length: 4 }, () => workflows.tick());
  assert.equal(new Set(waiters).size, 1);
  gates[0].reject(new Error("pass failed"));
  await assert.rejects(first, { message: "pass failed" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(workflows.again, null);
  gates[1].resolve();
  await Promise.all(waiters);
  assert.equal(workflows.running, null);
  // A later overlap works again.
  const later = workflows.tick();
  const follow = workflows.tick();
  gates[2].resolve();
  await later;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 4);
  gates[3].resolve();
  await follow;
  assert.equal(workflows.again, null);
});
