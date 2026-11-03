import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "../helpers/pipeline-engine.js";
import { RunQueue } from "../../server/features/pipelines/run-queue.js";

const ticket = {
  source: "plane",
  key: "AP-12",
  title: "Fix it",
  url: "https://plane.example/ap/AP-12",
};

test("a run keeps the ticket given by the server, not by the input", async (t) => {
  const f = fixture(t);
  const cwd = f.dir;
  const run = await f.engine.start(
    { pipelineId: "definition", cwd, task: "x", ticket: { key: "forged" } },
    { ticket },
  );
  assert.deepEqual(run.ticket, ticket);
  const plain = await f.engine.start({
    pipelineId: "definition",
    cwd,
    task: "x",
    ticket,
  });
  assert.equal(plain.ticket, null);
});

test("the ticket survives a restart and a malformed one is refused", async (t) => {
  const f = fixture(t);
  const run = await f.engine.start(
    { pipelineId: "definition", cwd: f.dir, task: "x" },
    { ticket },
  );
  await f.restart();
  assert.deepEqual(f.engine.get(run.id).ticket, ticket);
  await assert.rejects(
    f.engine.start(
      { pipelineId: "definition", cwd: f.dir, task: "x" },
      { ticket: { ...ticket, source: "jira" } },
    ),
    { message: "Ein Arbeitsverzeichnis und eine Aufgabe sind erforderlich." },
  );
});

test("a run saved before tickets existed loads without a ticket", async (t) => {
  const f = fixture(t);
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "x" });
  const db = new DatabaseSync(path.join(f.dir, "pipeline-runs", "runs.sqlite"));
  db.prepare("UPDATE runs SET doc=json_remove(doc, '$.ticket') WHERE id=?").run(run.id);
  assert.equal(
    db
      .prepare("SELECT json_type(doc, '$.ticket') AS type FROM runs WHERE id=?")
      .get(run.id).type,
    null,
  );
  db.close();
  await f.restart();
  assert.equal(f.engine.get(run.id).ticket ?? null, null);
});

// A queue over the synthetic engine of one project ("project").
function queueFixture(t) {
  let queue;
  const f = fixture(t, { options: { onChange: () => queue?.changed() } });
  f.definitions.getQueueSettings = (projectId) => ({
    projectId,
    limit: 5,
    countParked: false,
  });
  queue = new RunQueue({
    dataDir: f.dir,
    engine: f.engine,
    definitions: f.definitions,
    projects: (id) => ({ id, cwd: f.dir }),
    pollIntervalMs: 0,
  });
  t.after(() => queue.close());
  return { f, queue };
}

test("a ticket-sequence queue item starts its run with the ticket", async (t) => {
  const { f, queue } = queueFixture(t);
  const item = queue.add(
    "project",
    { pipelineId: "definition", task: "x", externalRef: "AP-12" },
    {
      id: "3f2b8c1e-0000-4000-8000-000000000001",
      source: { kind: "ticket-sequence", ticket },
    },
  );
  await queue.changed();
  assert.deepEqual(f.engine.get(item.id).ticket, ticket);
  assert.equal(queue.view("project").items[0].state, "started");
  assert.deepEqual(queue.view("project").items[0].source.ticket, ticket);
});

test("an invalid ticket on a queue item is refused", async (t) => {
  const { queue } = queueFixture(t);
  for (const bad of [undefined, null, { ...ticket, source: "jira" }, { key: "x" }])
    assert.throws(
      () =>
        queue.add(
          "project",
          { pipelineId: "definition", task: "x" },
          { source: { kind: "ticket-sequence", ticket: bad } },
        ),
      { status: 400 },
    );
  assert.equal(queue.view("project").items.length, 0);
});

test("user items still start without a ticket", async (t) => {
  const { f, queue } = queueFixture(t);
  const item = queue.add("project", { pipelineId: "definition", task: "x" });
  await queue.changed();
  assert.equal(f.engine.get(item.id).ticket, null);
  assert.equal(queue.view("project").items[0].state, "started");
});
