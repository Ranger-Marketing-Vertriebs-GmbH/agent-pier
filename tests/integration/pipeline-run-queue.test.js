import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { PipelineDefinitions } from "../../server/features/pipelines/pipeline-definitions.js";
import { fixture } from "../helpers/pipeline-engine.js";
import { RunQueue } from "../../server/features/pipelines/run-queue.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";
import { problem } from "../../server/lib/storage.js";

// A queue over the synthetic engine of one project ("project"); every run change
// reaches the queue like the application's onChange wiring.
function queueFixture(t, { limit = 1, countParked = false, gate = false } = {}) {
  let queue;
  const f = fixture(t, { gate, options: { onChange: () => queue?.changed() } });
  const settings = { limit, countParked };
  f.definitions.getQueueSettings = (projectId) => ({ projectId, ...settings });
  const audit = [];
  const make = (engine = f.engine) =>
    new RunQueue({
      dataDir: f.dir,
      engine,
      definitions: f.definitions,
      projects: (id) => {
        if (id !== "project") throw problem("Project not found", 404);
        return { id, cwd: f.dir };
      },
      audit: { append: (entry) => audit.push(auditEvent(entry)) },
      pollIntervalMs: 0,
    });
  queue = make();
  t.after(() => queue.close());
  return {
    f,
    audit,
    settings,
    get queue() {
      return queue;
    },
    replace(next) {
      queue = next;
    },
    make,
    add: (task, input = {}) =>
      queue.add("project", { pipelineId: "definition", task, ...input }),
    states: () => queue.view("project").items.map((i) => [i.task, i.state]),
    settle: () => queue.changed(),
  };
}

test("items start in order within the limit, the next one when a run finishes", async (t) => {
  const q = queueFixture(t);
  const a = q.add("A", { baseBranch: "main", tokenBudget: 500, externalRef: "AP-1" });
  const b = q.add("B");
  await q.settle();
  assert.deepEqual(q.states(), [
    ["A", "started"],
    ["B", "queued"],
  ]);
  assert.equal(q.f.launches.length, 1);
  // The run has the item's reserved id and its project, base branch and budget.
  const run = q.f.engine.get(a.id);
  assert.equal(run.task, "A");
  assert.equal(run.expectedProjectId, "project");
  assert.equal(run.baseBranch, "main");
  assert.equal(run.tokenBudget, 500);
  assert.equal(q.queue.view("project").items[0].run.status, "running");

  await q.f.end();
  await q.settle();
  assert.equal(q.f.engine.get(a.id).status, "completed");
  assert.deepEqual(q.states(), [
    ["A", "started"],
    ["B", "started"],
  ]);
  assert.equal(q.f.engine.get(b.id).task, "B");
  assert.deepEqual(
    q.audit.filter((e) => e.action === "pipeline.started").map((e) => e.resourceId),
    [a.id, b.id],
  );
  assert.deepEqual(q.audit[0].details, { kind: "queue" });
  assert.equal(q.audit[0].source, "system");
});

test("a higher limit starts several items at once", async (t) => {
  const q = queueFixture(t, { limit: 2 });
  for (const task of ["A", "B", "C"]) q.add(task);
  await q.settle();
  assert.deepEqual(
    q.states().map(([, state]) => state),
    ["started", "started", "queued"],
  );
});

test("a run parked at a gate frees its slot unless parked runs count", async (t) => {
  const q = queueFixture(t, { gate: true });
  const a = q.add("A");
  q.add("B");
  await q.settle();
  await q.f.end();
  await q.settle();
  assert.equal(q.f.engine.get(a.id).status, "awaiting-human");
  assert.deepEqual(q.states(), [
    ["A", "started"],
    ["B", "started"],
  ]);

  const counting = queueFixture(t, { gate: true, countParked: true });
  const parked = counting.add("A");
  counting.add("B");
  await counting.settle();
  await counting.f.end();
  await counting.settle();
  assert.equal(counting.f.engine.get(parked.id).status, "awaiting-human");
  assert.deepEqual(counting.states()[1], ["B", "queued"]);
  // Ending the parked run frees the slot.
  await counting.f.engine.cancel(parked.id);
  await counting.settle();
  assert.deepEqual(counting.states()[1], ["B", "started"]);
});

test("runs started outside the queue take slots too", async (t) => {
  const q = queueFixture(t);
  const manual = await q.f.engine.start({
    pipelineId: "definition",
    cwd: q.f.dir,
    task: "Manual",
  });
  q.add("A");
  await q.settle();
  assert.deepEqual(q.states(), [["A", "queued"]]);
  await q.f.engine.cancel(manual.id);
  await q.settle();
  assert.deepEqual(q.states(), [["A", "started"]]);
});

test("a removed item never starts; removing a started item keeps its run", async (t) => {
  const q = queueFixture(t);
  const a = q.add("A");
  const b = q.add("B");
  q.add("C");
  await q.settle();
  q.queue.remove("project", b.id);
  // Cancelling the queue's run frees its slot for the next item.
  await q.f.engine.cancel(a.id);
  await q.settle();
  assert.deepEqual(q.states(), [
    ["A", "started"],
    ["C", "started"],
  ]);
  assert.equal(q.f.launches.length, 2);
  assert.throws(() => q.f.engine.get(b.id), { status: 404 });
  q.queue.remove("project", a.id);
  assert.equal(q.f.engine.get(a.id).status, "cancelled");
  assert.deepEqual(q.states(), [["C", "started"]]);
  assert.throws(() => q.queue.remove("project", b.id), { status: 404 });
  assert.throws(() => q.queue.remove("elsewhere", a.id), { status: 404 });
});

test("a restart between claim and start resumes the same start exactly once", async (t) => {
  const q = queueFixture(t);
  // The first process claims the item and dies before the engine created the run.
  const hanging = q.make({
    store: q.f.engine.store,
    start: () => new Promise(() => {}),
  });
  q.queue.close();
  q.replace(hanging);
  const a = q.add("A");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(q.states(), [["A", "starting"]]);
  hanging.closed = true;
  hanging.store.close();

  await q.f.restart();
  const recovered = q.make();
  q.replace(recovered);
  await recovered.recover();
  await q.settle();
  assert.deepEqual(q.states(), [["A", "started"]]);
  assert.equal(q.f.launches.length, 1);
  assert.equal(q.f.engine.get(a.id).task, "A");
});

test("a restart after the run was created marks the item started without a second run", async (t) => {
  const q = queueFixture(t);
  // The engine created the run, then the process died before the item was updated.
  const engine = q.f.engine;
  const crashing = q.make({
    store: engine.store,
    start: (input, options) =>
      engine.start(input, options).then(() => new Promise(() => {})),
  });
  q.queue.close();
  q.replace(crashing);
  const a = q.add("A");
  q.add("B");
  for (let i = 0; i < 20 && q.f.launches.length === 0; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(q.f.launches.length, 1);
  crashing.closed = true;
  crashing.store.close();

  await q.f.restart();
  const recovered = q.make();
  q.replace(recovered);
  await recovered.recover();
  await q.settle();
  assert.deepEqual(q.states(), [
    ["A", "started"],
    ["B", "queued"],
  ]);
  assert.equal(q.f.launches.length, 1);
  assert.equal(q.f.engine.get(a.id).status, "running");
});

test("a refused start fails the item; retrying queues it again at its place", async (t) => {
  const q = queueFixture(t);
  const original = q.f.definitions.snapshot;
  const a = q.add("A");
  const b = q.add("B");
  // The definition breaks between queueing and starting.
  q.f.definitions.snapshot = () => {
    q.f.definitions.snapshot = original;
    throw problem("Profil deaktiviert", 409);
  };
  await q.settle();
  const failed = q.queue.view("project").items[0];
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "Profil deaktiviert");
  // The next item starts in the meantime.
  assert.deepEqual(q.states()[1], ["B", "started"]);
  assert.throws(() => q.queue.retry("project", b.id), { status: 409 });

  const retried = q.queue.retry("project", a.id);
  assert.equal(retried.state, "queued");
  assert.equal(retried.error, null);
  await q.settle();
  assert.deepEqual(q.states()[0], ["A", "queued"]);
  await q.f.end();
  await q.settle();
  assert.deepEqual(q.states()[0], ["A", "started"]);
});

test("waiting items move up and down; started items stay put", async (t) => {
  const q = queueFixture(t);
  const a = q.add("A");
  q.add("B");
  const c = q.add("C");
  await q.settle();
  q.queue.move("project", c.id, "up");
  assert.deepEqual(
    q.states().map(([task]) => task),
    ["A", "C", "B"],
  );
  // Already first among the waiting items: nothing changes.
  q.queue.move("project", c.id, "up");
  assert.deepEqual(
    q.states().map(([task]) => task),
    ["A", "C", "B"],
  );
  assert.throws(() => q.queue.move("project", a.id, "down"), { status: 409 });
  assert.throws(() => q.queue.move("project", c.id, "sideways"), { status: 400 });
  await q.f.end();
  await q.settle();
  assert.deepEqual(q.states(), [
    ["A", "started"],
    ["C", "started"],
    ["B", "queued"],
  ]);
});

test("adding validates the item and the queue's capacity", async (t) => {
  const q = queueFixture(t);
  for (const input of [
    { task: "" },
    { task: " " },
    { task: "x".repeat(65537) },
    { task: "A", externalRef: "x".repeat(121) },
    { task: "A", externalRef: "line\nbreak" },
    { task: "A", baseBranch: "x".repeat(301) },
    { task: "A", tokenBudget: 0 },
    { task: "A", tokenBudget: "100" },
  ])
    assert.throws(() => q.queue.add("project", { pipelineId: "definition", ...input }), {
      status: 400,
    });
  assert.throws(() => q.queue.add("elsewhere", { pipelineId: "definition", task: "A" }), {
    status: 404,
  });
  for (let i = 0; i < 200; i++)
    q.queue.store.insert({ id: `filler-${i}`, projectId: "project", state: "failed" });
  assert.throws(() => q.add("A"), { status: 409 });
  // An item's view never shows the folder it runs in.
  q.queue.store.remove("filler-0");
  const item = q.add("A", { externalRef: " AP-7 " });
  assert.equal(item.cwd, undefined);
  assert.equal(item.externalRef, "AP-7");
});

test("queue settings are stored per project and follow a folder that became a work tree", async (t) => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "agentpier-queue-defs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const accounts = { get: () => ({ id: "local-codex", tool: "codex" }), list: () => [] };
  let definitions = new PipelineDefinitions({ dataDir: root, accounts });
  assert.deepEqual(definitions.getQueueSettings("project-a"), {
    projectId: "project-a",
    limit: 1,
    countParked: false,
    custom: false,
  });
  assert.throws(() => definitions.saveQueueSettings("project-a", { limit: 0 }), {
    status: 400,
  });
  definitions.saveQueueSettings("project-a", { limit: 3, countParked: true });
  definitions = new PipelineDefinitions({ dataDir: root, accounts });
  assert.equal(definitions.getQueueSettings("project-a").limit, 3);
  assert.equal(definitions.hasVerification("project-a"), true);
  definitions.moveVerification("project-a", "project-b");
  assert.equal(definitions.getQueueSettings("project-a").custom, false);
  assert.deepEqual(definitions.getQueueSettings("project-b"), {
    projectId: "project-b",
    limit: 3,
    countParked: true,
    custom: true,
  });
  // Definitions written before run queues existed load with the defaults.
  const file = path.join(root, "pipelines", "definitions.json");
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  delete stored.queue;
  await fs.writeFile(file, JSON.stringify(stored));
  definitions = new PipelineDefinitions({ dataDir: root, accounts });
  assert.equal(definitions.getQueueSettings("project-b").custom, false);
});
