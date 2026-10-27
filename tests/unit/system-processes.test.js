import test from "node:test";
import assert from "node:assert/strict";
import { processGroups } from "../../web/features/dashboard/system-processes.js";

const rows = [
  { kind: "server", processes: 3, cpuPercent: 0.2, rssBytes: 300 },
  { kind: "gateway", processes: 7, cpuPercent: 0.5, rssBytes: 750 },
  {
    kind: "session",
    id: "b",
    name: "beta",
    processes: 4,
    cpuPercent: 2.4,
    rssBytes: 390,
  },
  {
    kind: "session",
    id: "a",
    name: "Alpha",
    processes: 5,
    cpuPercent: 3.1,
    rssBytes: 410,
  },
  { kind: "session", id: "c", name: "gamma", processes: 1, cpuPercent: 0, rssBytes: 12 },
];
const name = (item) => item.name || item.kind;
const order = (group) => group.rows.map((item) => item.id || item.kind);

test("rows split into the AgentPier core and the sessions, each with its subtotal", () => {
  const { core, sessions } = processGroups(rows, "cpu", name);
  assert.deepEqual(order(core), ["gateway", "server"]);
  assert.deepEqual(order(sessions), ["a", "b", "c"]);
  assert.deepEqual(
    { cpu: core.cpuPercent, rss: core.rssBytes, count: core.processes },
    { cpu: 0.7, rss: 1050, count: 10 },
  );
  assert.deepEqual(
    { cpu: sessions.cpuPercent, rss: sessions.rssBytes, count: sessions.processes },
    { cpu: 5.5, rss: 812, count: 10 },
  );
});

test("sorting applies inside each group by RAM or by name", () => {
  const memory = processGroups(rows, "memory", name);
  assert.deepEqual(order(memory.core), ["gateway", "server"]);
  assert.deepEqual(order(memory.sessions), ["a", "b", "c"]);
  const byName = processGroups(rows, "name", name);
  assert.deepEqual(order(byName.core), ["gateway", "server"]);
  assert.deepEqual(order(byName.sessions), ["a", "b", "c"]);
  const reversed = processGroups(
    rows.map((item) => (item.id === "c" ? { ...item, name: "aardvark" } : item)),
    "name",
    name,
  );
  assert.deepEqual(order(reversed.sessions), ["c", "a", "b"]);
});

test("the bars scale to the largest row of both groups", () => {
  assert.deepEqual(processGroups(rows, "cpu", name).largest, {
    cpuPercent: 3.1,
    rssBytes: 750,
  });
  assert.deepEqual(processGroups([], "cpu", name), {
    core: { rows: [], cpuPercent: 0, rssBytes: 0, processes: 0 },
    sessions: { rows: [], cpuPercent: 0, rssBytes: 0, processes: 0 },
    largest: { cpuPercent: 0, rssBytes: 0 },
  });
});
