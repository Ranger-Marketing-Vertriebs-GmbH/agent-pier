import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "../helpers/pipeline-engine.js";

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
