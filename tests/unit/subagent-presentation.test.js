import test from "node:test";
import assert from "node:assert/strict";
import {
  subagentRowStatus,
  presentSubagents,
  subagentHeading,
  SUBAGENT_LINGER_MS,
  SUBAGENT_FIRST_SEEN_TOLERANCE_MS,
  SUBAGENT_FADE_MS,
} from "../../web/features/chat/subagent-presentation.js";

const row = (status, agentId = "agent1") => ({
  id: "toolu_1",
  role: "tool",
  status,
  subagent: { description: "Review", type: "general-purpose", status, agentId },
});

test("a frozen running row follows the observed state of its agent while live", () => {
  assert.equal(
    subagentRowStatus(row("running"), [{ id: "agent1", status: "completed" }], true),
    "completed",
  );
  assert.equal(
    subagentRowStatus(row("running"), [{ id: "agent1", status: "failed" }], true),
    "failed",
  );
  assert.equal(
    subagentRowStatus(row("running"), [{ id: "agent1", status: "running" }], true),
    "running",
  );
  // An agent the observer does not know is never reported as working.
  assert.equal(subagentRowStatus(row("running"), [], true), "unknown");
  assert.equal(subagentRowStatus(row("completed"), [], true), "completed");
  // Saved or stale data never shows a working agent, whatever the observer says.
  assert.equal(
    subagentRowStatus(row("running"), [{ id: "agent1", status: "running" }], false),
    "unknown",
  );
  assert.equal(subagentRowStatus(row("completed"), [], false), "completed");
  // A foreground call before its launch result has no agent id yet.
  assert.equal(subagentRowStatus(row("running", null), [], true), "running");
});

const LINGER = SUBAGENT_LINGER_MS;
const FADE = SUBAGENT_FADE_MS;
const ids = (result) => result.subagents.map((agent) => agent.id);
const fading = (result) =>
  result.subagents.filter((agent) => agent.fading).map((agent) => agent.id);

test("a finished subagent lingers, fades out and is then removed for good", () => {
  const memory = new Map();
  const working = [{ id: "a", status: "running" }];
  let result = presentSubagents(memory, working, true, 1000);
  assert.deepEqual(ids(result), ["a"]);
  assert.equal(result.next, null);
  const done = [{ id: "a", status: "completed", updatedAt: "2020-01-01T00:00:00Z" }];
  // Client time counts from the first finished frame, whatever the server says.
  result = presentSubagents(memory, done, true, 5000);
  assert.deepEqual(ids(result), ["a"]);
  assert.deepEqual(fading(result), []);
  assert.equal(result.next, 5000 + LINGER);
  result = presentSubagents(memory, done, true, 5000 + LINGER - 1);
  assert.deepEqual(fading(result), []);
  result = presentSubagents(memory, done, true, 5000 + LINGER);
  assert.deepEqual(fading(result), ["a"]);
  assert.equal(result.next, 5000 + LINGER + FADE);
  result = presentSubagents(memory, done, true, 5000 + LINGER + FADE);
  assert.deepEqual(ids(result), []);
  assert.equal(result.next, null);
  // Later frames never bring a removed agent back ...
  assert.deepEqual(ids(presentSubagents(memory, done, true, 99999)), []);
  // ... unless it starts working again.
  assert.deepEqual(ids(presentSubagents(memory, working, true, 100000)), ["a"]);
});

test("a changed final state of a removed agent is shown for one more linger", () => {
  const memory = new Map();
  const at = Date.parse("2026-09-07T10:00:00Z");
  const show = (status, time) =>
    ids(
      presentSubagents(
        memory,
        [{ id: "a", status, updatedAt: "2026-09-07T09:00:00Z" }],
        true,
        at + time,
      ),
    );
  // Already old at first sight: removed without being listed.
  assert.deepEqual(show("unknown", 0), []);
  assert.deepEqual(show("unknown", 10), []);
  assert.deepEqual(show("completed", 20), ["a"]);
  assert.deepEqual(show("completed", 20 + LINGER - 1), ["a"]);
  assert.deepEqual(show("completed", 20 + LINGER + FADE), []);
  assert.deepEqual(show("completed", 21 + LINGER + FADE), []);
});

test("without a fade a finished agent is removed when its linger ends", () => {
  const memory = new Map();
  const done = [{ id: "a", status: "completed" }];
  const options = { fade: 0 };
  presentSubagents(memory, done, true, 0, options);
  const before = presentSubagents(memory, done, true, LINGER - 1, options);
  assert.deepEqual(ids(before), ["a"]);
  assert.deepEqual(fading(before), []);
  assert.equal(before.next, LINGER);
  assert.deepEqual(ids(presentSubagents(memory, done, true, LINGER, options)), []);
});

test("agents that finished long before they were first seen are not listed", () => {
  const now = Date.parse("2026-09-07T10:01:00Z");
  const agents = [
    { id: "old", status: "completed", updatedAt: "2026-09-07T09:00:00Z" },
    { id: "fresh", status: "failed", updatedAt: "2026-09-07T10:00:55Z" },
    { id: "untimed", status: "completed" },
  ];
  const result = presentSubagents(new Map(), agents, true, now);
  assert.deepEqual(ids(result), ["fresh", "untimed"]);
  assert.equal(result.next, now + LINGER);
});

test("an agent first seen finished within the clock-skew tolerance is still listed", () => {
  assert.equal(SUBAGENT_FIRST_SEEN_TOLERANCE_MS, 60_000);
  const now = Date.parse("2026-09-07T10:01:00Z");
  const agents = [
    { id: "skewed", status: "completed", updatedAt: "2026-09-07T10:00:30Z" },
    { id: "old", status: "completed", updatedAt: "2026-09-07T09:59:50Z" },
  ];
  const result = presentSubagents(new Map(), agents, true, now);
  assert.deepEqual(ids(result), ["skewed"]);
  // The linger runs on client time from the first frame.
  assert.equal(result.next, now + LINGER);
});

test("working agents come first and finished ones keep a stable order", () => {
  const memory = new Map();
  presentSubagents(memory, [{ id: "x", status: "completed" }], true, 0);
  const agents = [
    { id: "x", status: "completed" },
    { id: "w", status: "running" },
    { id: "y", status: "failed" },
  ];
  assert.deepEqual(ids(presentSubagents(memory, agents, true, 10)), ["w", "y", "x"]);
  assert.deepEqual(ids(presentSubagents(memory, agents, true, 20)), ["w", "y", "x"]);
});

test("saved or stale data never shows a working or unresolved agent", () => {
  const memory = new Map();
  const agents = [
    { id: "w", status: "running" },
    { id: "u", status: "unknown" },
    { id: "c", status: "completed" },
  ];
  assert.deepEqual(ids(presentSubagents(memory, agents, false, 0)), ["c"]);
  // A working agent hidden by a stale frame is listed again once data is live.
  assert.deepEqual(ids(presentSubagents(memory, agents, true, 10)), ["w", "u", "c"]);
});

test("the heading counts listed and working subagents", () => {
  const running = { id: "a", status: "running" };
  const done = { id: "b", status: "completed" };
  assert.match(subagentHeading([running]), /\(1\)/);
  assert.match(subagentHeading([running, done]), /\(2 · 1/);
  assert.match(subagentHeading([done]), /\(1\)/);
});
