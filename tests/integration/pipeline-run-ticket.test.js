import test from "node:test";
import assert from "node:assert/strict";
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
  );
});
