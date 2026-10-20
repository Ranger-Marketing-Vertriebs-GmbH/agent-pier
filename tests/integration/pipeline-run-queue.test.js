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
import { MutationBarrier } from "../../server/application/mutation-barrier.js";

// A queue over the synthetic engine of one project ("project"); every run change
// reaches the queue like the application's onChange wiring.
function queueFixture(
  t,
  { limit = 1, countParked = false, gate = false, mutationBarrier } = {},
) {
  let queue;
  const f = fixture(t, {
    gate,
    options: { onChange: () => queue?.changed(), mutationBarrier },
  });
  // Registered projects, and rebinds recorded for projects that are gone.
  const known = new Set(["project"]),
    moved = new Map();
  const settings = { limit, countParked };
  f.definitions.getQueueSettings = (projectId) => ({ projectId, ...settings });
  const audit = [];
  const make = (engine = f.engine) =>
    new RunQueue({
      dataDir: f.dir,
      engine,
      definitions: f.definitions,
      projects: (id) => {
        if (!known.has(id)) throw problem("Project not found", 404);
        return { id, cwd: id === "project" ? f.dir : `${f.dir}/${id}` };
      },
      projectMoved: (id) => moved.get(id) ?? null,
      audit: { append: (entry) => audit.push(auditEvent(entry)) },
      pollIntervalMs: 0,
    });
  queue = make();
  t.after(() => queue.close());
  return {
    f,
    audit,
    settings,
    known,
    moved,
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
  assert.deepEqual(q.audit[0].details, {
    kind: "queue",
    tokenBudget: 500,
    tokenBudgetSource: "start",
  });
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

test("items of a project that is gone fail with the reason and never start", async (t) => {
  const q = queueFixture(t);
  q.f.engine.store.create({
    id: "busy",
    status: "running",
    projectId: "project",
    nodes: [],
  });
  const a = q.add("A");
  await q.settle();
  q.known.delete("project");
  q.f.engine.store.remove("busy");
  await q.settle();
  assert.equal(q.f.launches.length, 0);
  const failed = q.queue.find(a.id);
  assert.equal(failed.state, "failed");
  assert.equal(
    failed.error,
    "Das Projekt dieses Eintrags ist nicht mehr registriert. Der Eintrag startet nicht.",
  );
  assert.deepEqual(
    q.audit.filter((e) => e.action === "pipeline.failed").map((e) => e.details),
    [{ kind: "queue", failReason: "project-gone" }],
  );
});

test("items of a rebound project follow it to its new id", async (t) => {
  const q = queueFixture(t);
  q.f.engine.store.create({
    id: "busy",
    status: "running",
    projectId: "project",
    nodes: [],
  });
  q.add("A");
  q.add("B");
  await q.settle();
  // The folder became a Git work tree: the old row is gone, the rebind recorded.
  q.known.delete("project");
  q.known.add("work-tree");
  q.moved.set("project", "work-tree");
  q.f.engine.store.create({
    id: "busy-2",
    status: "running",
    projectId: "work-tree",
    nodes: [],
  });
  await q.settle();
  assert.equal(q.queue.ownsProject("project"), false);
  const items = q.queue.view("work-tree").items;
  assert.deepEqual(
    items.map((i) => [i.task, i.state]),
    [
      ["A", "queued"],
      ["B", "queued"],
    ],
  );
  assert.equal(q.queue.find(items[0].id).cwd, `${q.f.dir}/work-tree`);
  assert.equal(q.f.launches.length, 0);
});

test("a start triggered inside a mutation lease takes a lease of its own", async (t) => {
  const barrier = new MutationBarrier();
  const q = queueFixture(t, { mutationBarrier: barrier });
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const prepare = q.f.workspace.prepare;
  q.f.workspace.prepare = async (input) => {
    await held;
    return prepare(input);
  };
  let item;
  // Like a run that finishes inside the engine's lock: the queue is triggered while
  // that lease is active, and the lease ends while the new run is still provisioning.
  await barrier.run(async () => {
    item = q.add("A");
    for (let i = 0; i < 100 && !q.f.engine.store.all().length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
  });
  assert.equal(q.f.engine.store.get(item.id).phase, "provisioning");
  let snapshotted = false;
  const snapshot = barrier.snapshot(async () => {
    snapshotted = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  // A backup waits for the start's own lease instead of copying a half-written run.
  assert.equal(snapshotted, false);
  release();
  await snapshot;
  await q.settle();
  assert.equal(snapshotted, true);
  assert.equal(q.queue.find(item.id).state, "started");
});

test("start-up only marks existing runs started and leaves other starts to the background", async (t) => {
  const q = queueFixture(t);
  const a = q.add("A");
  await q.settle();
  // As after a crash: the run exists, the item still says starting.
  q.queue.store.save({ ...q.queue.find(a.id), state: "starting" });
  const b = q.queue.store.insert({
    ...q.queue.find(a.id),
    id: "interrupted",
    task: "B",
    state: "starting",
  });
  q.queue.close();
  const recovered = q.make();
  q.replace(recovered);
  let started = 0;
  const start = q.f.engine.start.bind(q.f.engine);
  q.f.engine.start = (...args) => {
    started++;
    return start(...args);
  };
  recovered.recover();
  // Synchronously: the existing run marked its item, nothing was launched yet.
  assert.equal(recovered.find(a.id).state, "started");
  assert.equal(recovered.find(b.id).state, "starting");
  assert.equal(started, 0);
  await q.settle();
  assert.equal(started, 1);
  assert.equal(recovered.find(b.id).state, "started");
});

// Holds provisioning of runs in one folder until released.
function holdFolder(q, folder) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const prepare = q.f.workspace.prepare;
  q.f.workspace.prepare = async (input) => {
    if (input.cwd === folder) await held;
    const prepared = await prepare(input);
    // Runs of another folder belong to that project.
    return input.cwd === q.f.dir
      ? prepared
      : { ...prepared, projectId: input.cwd.split("/").at(-1) };
  };
  return release;
}
const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check());
};

test("an item whose project moves while it starts ends up in the moved project", async (t) => {
  const q = queueFixture(t);
  const release = holdFolder(q, q.f.dir);
  q.known.add("work-tree");
  const waiting = q.queue.store.insert({
    id: "waiting",
    projectId: "work-tree",
    state: "failed",
    task: "W",
  });
  const a = q.add("A");
  const settled = q.settle();
  await until(() => q.f.engine.store.all().length === 1);
  assert.equal(q.queue.find(a.id).state, "starting");
  q.queue.moveProject("project", "work-tree");
  release();
  await settled;
  const item = q.queue.find(a.id);
  assert.equal(item.state, "started");
  assert.equal(item.projectId, "work-tree");
  assert.equal(q.queue.ownsProject("project"), false);
  assert.deepEqual(
    q.queue.store.list("work-tree").map((i) => [i.id, i.position]),
    [
      [waiting.id, waiting.position],
      [a.id, waiting.position + 1],
    ],
  );
});

test("a slow start in one project does not hold back another project", async (t) => {
  const q = queueFixture(t);
  const release = holdFolder(q, q.f.dir);
  q.known.add("other");
  const a = q.add("A");
  await until(() => q.f.engine.store.all().length === 1);
  const b = q.queue.add("other", { pipelineId: "definition", task: "B" });
  await until(() => q.queue.find(b.id).state === "started");
  assert.equal(q.queue.find(a.id).state, "starting");
  assert.equal(q.f.engine.get(b.id).projectId, "other");
  release();
  await q.settle();
  assert.equal(q.queue.find(a.id).state, "started");
  // Each project started exactly one run.
  assert.equal(q.f.launches.length, 2);
});
