import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { applicationFixture } from "../helpers/application.js";
import { RunStore } from "../../server/features/pipelines/run-store.js";
import { RUN_STATUSES } from "../../server/features/pipelines/run-counts.js";
import { availableActions } from "../../server/features/pipelines/pipeline-actions.js";

const run = (id, projectId, status, extra = {}) => ({
  id,
  status,
  projectId,
  pipelineName: "Release",
  task: `Task ${id}\nwith a second line`,
  cwd: "/fixture/app",
  currentNodeId: "build",
  nodes: [{ id: "build", status: status === "running" ? "running" : "passed" }],
  edges: [],
  executionLog: [{ id: `turn-${id}`, nodeId: "build", status: "passed" }],
  createdAt: "2026-10-17T10:00:00.000Z",
  ...extra,
});

// The list as it was before it paged in SQL: every run parsed, filtered and sliced.
function scanned(store, { page = 1, status, projectId } = {}) {
  const all = store
    .all()
    .filter(
      (r) =>
        (!status || r.status === status) && (!projectId || r.projectId === projectId),
    );
  return {
    runs: all
      .slice((page - 1) * 20, page * 20)
      .map((r) => ({ ...r, actions: availableActions(r) })),
    total: all.length,
    page,
    pageSize: 20,
  };
}

test("the paged list equals the full scan for every filter and page", async (t) => {
  const f = await applicationFixture(t);
  const { pipelines } = f.application;
  const projects = [null, "p1", "p2"];
  const statuses = [...RUN_STATUSES, "paused"];
  for (let index = 0; index < 57; index += 1)
    pipelines.store.create(
      run(`r${index}`, projects[index % 3], statuses[(index * 7) % statuses.length]),
    );
  for (const projectId of [undefined, "p1", "p2", "nothing"])
    for (const status of [undefined, ...RUN_STATUSES])
      for (const page of [1, 2, 3, 4])
        assert.deepEqual(
          pipelines.list({ page, status, projectId }),
          scanned(pipelines.store, { page, status, projectId }),
          JSON.stringify({ page, status, projectId }),
        );
});

test("the list view carries no execution log and no actions", async (t) => {
  const f = await applicationFixture(t);
  f.application.pipelines.store.create(
    run("slim", "p1", "running", { verifyJob: { id: "job" } }),
  );
  const whole = await (await f.request("/api/pipeline-runs")).json();
  assert.ok(whole.runs[0].executionLog && whole.runs[0].actions);
  const slim = await (await f.request("/api/pipeline-runs?view=list")).json();
  assert.deepEqual(slim.runs, [
    {
      id: "slim",
      status: "running",
      task: "Task slim",
      pipelineName: "Release",
      cwd: "/fixture/app",
      projectId: "p1",
      createdAt: "2026-10-17T10:00:00.000Z",
      currentNodeId: "build",
      verifyJob: true,
      nodes: [{ id: "build", status: "running" }],
    },
  ]);
  assert.equal((await f.request("/api/pipeline-runs?view=full")).status, 400);
});

test("counts after a restart equal a scan, also for a run recovery moved", async (t) => {
  const f = await applicationFixture(t, {
    prepareDataDir: async (dataDir) => {
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      const store = new RunStore(dataDir);
      // Its turn is gone: recovery parks it, so it no longer counts as running.
      store.create(run("lost", "p1", "running"));
      store.create(run("done", "p1", "completed"));
      store.create(run("broken", "p2", "failed"));
      store.close();
    },
  });
  const expect = async () => {
    const listed = await (await f.request("/api/pipeline-runs")).json();
    const counts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0]));
    for (const item of listed.runs) counts[item.status] += 1;
    assert.deepEqual(await (await f.request("/api/pipeline-run-counts")).json(), {
      counts,
      total: listed.total,
    });
    return counts;
  };
  const counts = await expect();
  assert.equal(counts.running, 0);
  assert.equal(counts.completed, 1);
  assert.equal(counts.failed + counts["awaiting-human"], 2);
  await f.restart();
  assert.deepEqual(await expect(), counts);
});
