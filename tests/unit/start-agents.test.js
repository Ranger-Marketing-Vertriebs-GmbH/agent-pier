import test from "node:test";
import assert from "node:assert/strict";
import {
  recentFailures,
  runSegments,
  startAgents,
  startRuns,
} from "../../web/features/dashboard/start-agents.js";
import { agentFilters, filterList } from "../../web/features/dashboard/start-lists.js";
import { assistantCopy } from "../../web/lib/i18n/messages/assistants.js";
import { longListAgents } from "../fixtures/long-lists.js";

const ready = { availability: "ready", sync: "current" };

test("the long-list agents sort needs you, working, ready with their team notes", () => {
  const data = longListAgents();
  const items = startAgents({ ...data, runtime: ready, copy: assistantCopy });
  assert.equal(items.length, 14, "temporary team members are not listed");
  const { rows, counts } = filterList(items, {
    filters: agentFilters,
    filter: "all",
    query: "",
  });
  assert.deepEqual(counts, { all: 14, needsYou: 2, working: 3, ready: 9 });
  assert.deepEqual(
    rows.slice(0, 5).map((row) => row.name),
    ["Buchhaltung", "Code-Review", "Datenpflege", "Recherche", "Support Bilen"],
  );
  const lead = items.find((item) => item.name === "Code-Review");
  assert.deepEqual(lead.team, { kind: "lead", count: 2 });
  const shared = items.find((item) => item.name === "Support Bilen");
  assert.deepEqual(shared.team, { kind: "shared", count: 1 });
});

test("a stopped agent service makes every agent offline", () => {
  const data = longListAgents();
  const items = startAgents({
    ...data,
    runtime: { availability: "failed" },
    copy: assistantCopy,
  });
  assert.ok(items.every((item) => item.state === "offline"));
  assert.ok(items.every((item) => item.line === assistantCopy.sidebarServiceOffline));
});

test("the pipelines card takes running, awaiting and failed runs, at most three", () => {
  const run = (id, status, createdAt) => ({ id, status, createdAt });
  assert.equal(startRuns(null), null);
  assert.equal(startRuns({ running: null, decisions: null, failed: null }), null);
  assert.deepEqual(startRuns({ running: [], decisions: [], failed: null }), []);
  const picked = startRuns({
    running: [
      run("r1", "running", "2026-10-27T10:00:00Z"),
      run("r2", "running", "2026-10-27T11:00:00Z"),
    ],
    decisions: [run("d1", "awaiting-human", "2026-10-27T12:00:00Z")],
    failed: [run("f1", "failed", "2026-10-27T13:00:00Z")],
  });
  assert.deepEqual(
    picked.map((item) => item.id),
    ["r2", "r1", "d1"],
  );
});

test("a run's stages become passed, current, failed and open segments", () => {
  assert.deepEqual(
    runSegments({
      currentNodeId: "c",
      nodes: [
        { id: "a", status: "passed" },
        { id: "g", group: true, status: "passed" },
        { id: "b", status: "failed" },
        { id: "c", status: "running" },
        { id: "d", status: "pending" },
      ],
    }).map((segment) => segment.state),
    ["passed", "failed", "current", "open"],
  );
});

test("failed runs show only when they failed in the last 24 hours", () => {
  const now = Date.parse("2026-10-27T18:00:00Z");
  const failed = [
    { id: "fresh", status: "failed", finishedAt: "2026-10-27T10:00:00Z" },
    { id: "old", status: "failed", finishedAt: "2026-10-26T17:00:00Z" },
    {
      id: "nodes",
      status: "failed",
      createdAt: "2026-10-20T10:00:00Z",
      nodes: [{ id: "a", finishedAt: "2026-10-27T17:00:00Z" }],
    },
    { id: "unknown", status: "failed" },
  ];
  assert.deepEqual(
    recentFailures(failed, now).map((run) => run.id),
    ["fresh", "nodes"],
  );
  assert.deepEqual(
    startRuns({ running: [], decisions: [], failed }, 3, now).map((run) => run.id),
    ["nodes", "fresh"],
  );
  assert.deepEqual(
    startRuns({ running: [], decisions: [], failed: failed.slice(1, 2) }, 3, now),
    [],
  );
});
