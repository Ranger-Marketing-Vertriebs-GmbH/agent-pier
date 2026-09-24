import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeProjects,
  resolveProjectId,
  groupRunCounts,
  latestGate,
  sweepRunCounts,
} from "../../web/features/projects/useProjectHub.js";

test("repository, knowledge and AgentBus projects join by folder", () => {
  const projects = mergeProjects({
    repositories: [
      {
        id: "r1",
        name: "agent-pier",
        url: "https://github.com/a/b",
        path: "/w/agent-pier/",
        credentialId: "c1",
      },
    ],
    memoryProjects: [
      { id: "m1", name: "agent-pier", cwd: "/w/agent-pier", entryCount: 4 },
      { id: "m2", name: "notes", cwd: "/w/notes", entryCount: 0 },
    ],
    busProjects: [{ id: "b1", cwd: "/w/agent-pier", sessions: [] }],
  });
  assert.deepEqual(
    projects.map((p) => [p.id, p.repositoryId, p.memoryId, p.busId]),
    [
      ["m1", "r1", "m1", "b1"],
      ["m2", "", "m2", ""],
    ],
  );
  assert.equal(resolveProjectId(projects, "r1"), "m1");
  assert.equal(resolveProjectId(projects, "b1"), "m1");
  assert.equal(resolveProjectId(projects, "zz"), "");
});

test("merged projects carry the joined facts and sort by name without case", () => {
  const [first, second, third] = mergeProjects({
    repositories: [
      {
        id: "r2",
        name: "Zeta",
        url: "https://github.com/acme/zeta.git",
        path: "/w/zeta",
        credentialId: "c2",
      },
    ],
    memoryProjects: [{ id: "m1", name: "alpha", cwd: "/w/alpha/", entryCount: 3 }],
    busProjects: [
      { id: "b1", name: "alpha", cwd: "/w/alpha", sessions: [{ id: "s" }] },
      { id: "b2", name: "Beta", cwd: "/w/beta", sessions: [{ id: "a" }, { id: "b" }] },
    ],
  });
  assert.deepEqual(first, {
    id: "m1",
    name: "alpha",
    path: "/w/alpha",
    remote: "",
    credentialId: "",
    repositoryId: "",
    memoryId: "m1",
    busId: "b1",
    entryCount: 3,
    sessionCount: 1,
  });
  assert.deepEqual(
    [second.id, second.busId, second.sessionCount, second.path],
    ["b2", "b2", 2, "/w/beta"],
  );
  assert.deepEqual(
    [third.id, third.repositoryId, third.remote, third.credentialId, third.entryCount],
    ["r2", "r2", "https://github.com/acme/zeta.git", "c2", 0],
  );
  assert.equal(resolveProjectId([first, second, third], "r2"), "r2");
  assert.equal(resolveProjectId([first, second, third], ""), "");
});

test("missing sources and a root folder are tolerated", () => {
  const projects = mergeProjects({
    repositories: undefined,
    memoryProjects: [{ id: "root", name: "/", cwd: "/", entryCount: 0 }],
    busProjects: null,
  });
  assert.deepEqual(
    projects.map((p) => [p.id, p.path]),
    [["root", "/"]],
  );
});

test("run counts group by the memory project id", () => {
  assert.deepEqual(
    groupRunCounts([
      { id: "1", projectId: "m1" },
      { id: "2", projectId: "m1" },
      { id: "3", projectId: "m2" },
      { id: "4" },
    ]),
    { m1: 2, m2: 1 },
  );
});

test("the latest gate applies only answers newer than the last applied one", () => {
  const gate = latestGate();
  const load = gate.start(),
    poll = gate.start();
  assert.equal(gate.apply(poll), true);
  assert.equal(gate.apply(load), false);
  const next = gate.start();
  assert.equal(gate.apply(next), true);
  assert.equal(gate.apply(next), false);
});

test("the run sweep reads further pages at once and marks a capped status", async () => {
  const runs = Array.from({ length: 130 }, (_, index) => ({
    id: String(index),
    projectId: index < 30 ? "m1" : "m2",
  }));
  const requested = [];
  let open = 0,
    parallel = 0;
  const read = async (page) => {
    requested.push(page);
    open++;
    parallel = Math.max(parallel, open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open--;
    return { runs: runs.slice((page - 1) * 20, page * 20), total: 130, pageSize: 20 };
  };
  const result = await sweepRunCounts(read);
  assert.deepEqual(requested.sort(), [1, 2, 3, 4, 5]);
  assert.ok(parallel > 1);
  assert.deepEqual(result, { counts: { m1: 30, m2: 70 }, capped: true });
  const small = await sweepRunCounts(async () => ({
    runs: [{ id: "1", projectId: "m1" }],
    total: 1,
    pageSize: 20,
  }));
  assert.deepEqual(small, { counts: { m1: 1 }, capped: false });
});
