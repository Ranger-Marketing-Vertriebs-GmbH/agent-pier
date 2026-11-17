import test from "node:test";
import assert from "node:assert/strict";
import {
  completedStartsOpen,
  groupSubagents,
  groupTasks,
  tasksLine,
} from "../../web/features/chat/background-tasks.js";

const agent = (id, status, updatedAt = null) => ({ id, status, updatedAt });
const ids = (agents) => agents.map((entry) => entry.id);

test("live data splits running from finished, newest completion first", () => {
  const result = groupSubagents(
    [
      agent("a", "completed", "2026-11-16T10:00:00Z"),
      agent("b", "running"),
      agent("c", "failed", "2026-11-16T11:00:00Z"),
      agent("d", "completed"),
    ],
    true,
  );
  assert.deepEqual(ids(result.running), ["b"]);
  assert.deepEqual(ids(result.finished), ["c", "a", "d"]);
});

test("saved data never lists a running or unresolved agent", () => {
  const result = groupSubagents(
    [agent("a", "running"), agent("b", "unknown"), agent("c", "completed")],
    false,
  );
  assert.deepEqual(result.running, []);
  assert.deepEqual(ids(result.finished), ["c"]);
});

test("an unresolved agent is listed as finished while live", () => {
  assert.deepEqual(ids(groupSubagents([agent("a", "unknown")], true).finished), ["a"]);
});

test("finished agents with the same time keep their given order", () => {
  const at = "2026-11-16T10:00:00Z";
  const result = groupSubagents(
    [agent("x", "completed", at), agent("y", "failed", at), agent("z", "completed")],
    true,
  );
  assert.deepEqual(ids(result.finished), ["x", "y", "z"]);
});

test("missing input yields empty groups", () => {
  assert.deepEqual(groupSubagents(), { running: [], finished: [] });
  assert.deepEqual(groupSubagents(null, true), { running: [], finished: [] });
});

test("the line prefers running agents, then open to-dos, then history", () => {
  const done = { status: "completed" },
    open = { status: "pending" };
  assert.deepEqual(tasksLine({ running: [1, 2], finished: [], tasks: [open] }), {
    kind: "running",
    count: 2,
  });
  assert.deepEqual(tasksLine({ running: [], finished: [1], tasks: [done, open] }), {
    kind: "todos",
    done: 1,
    total: 2,
  });
  assert.deepEqual(tasksLine({ running: [], finished: [1], tasks: [] }), {
    kind: "history",
  });
  assert.deepEqual(tasksLine({ running: [], finished: [], tasks: [done] }), {
    kind: "history",
  });
  assert.equal(tasksLine({ running: [], finished: [], tasks: [] }), null);
});

test("tasks group agents and shells by kind; stopped counts as finished", () => {
  const g = groupTasks(
    {
      subagents: [{ id: "a", status: "stopped" }],
      shells: [{ id: "s", status: "running", command: "sleep 300" }],
    },
    true,
  );
  assert.deepEqual(
    [g.running.map((e) => e.kind), g.finished.map((e) => e.id)],
    [["shell"], ["a"]],
  );
  assert.equal(g.finished[0].kind, "agent");
  assert.deepEqual(tasksLine({ ...g, tasks: [] }), { kind: "running", count: 1 });
});

test("saved tasks keep a stopped entry and drop a running shell", () => {
  const g = groupTasks(
    {
      subagents: [{ id: "a", status: "stopped" }],
      shells: [
        { id: "s", status: "running" },
        { id: "t", status: "completed", updatedAt: "2026-11-16T10:00:00Z" },
      ],
    },
    false,
  );
  assert.deepEqual(g.running, []);
  assert.deepEqual(ids(g.finished), ["t", "a"]);
  assert.deepEqual(groupTasks({}, true), { running: [], finished: [] });
});

test("Completed starts collapsed above five entries", () => {
  assert.equal(completedStartsOpen(Array(5).fill({})), true);
  assert.equal(completedStartsOpen(Array(6).fill({})), false);
});
