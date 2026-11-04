import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { setup } from "../helpers/mcp-pipeline-fixture.js";

const anchor = {
  side: "new",
  line: 3,
  text: "return ok();",
  before: ["a"],
  after: ["b"],
  excerpt: [{ kind: "add", text: "return ok();" }],
};
const body = {
  workspace: "",
  file: "server/a.js",
  side: "new",
  line: 3,
  anchor,
  body: "x",
};

test("deleting a session discards its review comments", async (t) => {
  const f = await applicationFixture(t);
  const executable = path.join(f.root, "idle-cli.cjs");
  fs.writeFileSync(executable, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, {
    mode: 0o700,
  });
  f.application.accounts.command = () => ({ command: executable, args: [], env: {} });
  const created = await f.request("/api/sessions", {
    method: "POST",
    body: { accountId: "local-codex", cwd: f.project, agentbus: false },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const session = await created.json();
  const scope = { kind: "session", id: session.id };
  const comment = await f.request(`/api/sessions/${session.id}/review-comments`, {
    method: "POST",
    body,
  });
  assert.equal(comment.status, 201);
  assert.equal(f.application.reviewComments.list(scope).comments.length, 1);
  assert.equal(
    (await f.request(`/api/sessions/${session.id}/stop`, { method: "POST" })).status,
    200,
  );
  // A stop keeps the comments; only the deletion ends them.
  assert.equal(f.application.reviewComments.list(scope).comments.length, 1);
  const removed = await f.request(`/api/sessions/${session.id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  assert.deepEqual(f.application.reviewComments.list(scope), {
    comments: [],
    batches: 0,
  });
});

test("deleting a pipeline run discards its review comments", async (t) => {
  const c = await setup(t);
  c.services.pipelines.workspace.remove = async () => {};
  const run = await c.services.pipelines.start({
    pipelineId: c.pipeline.id,
    cwd: c.app.project,
    task: "Review me",
  });
  const scope = { kind: "run", id: run.id };
  const { workspace: _w, ...runBody } = body;
  const comment = await c.app.request(`/api/pipeline-runs/${run.id}/review-comments`, {
    method: "POST",
    body: runBody,
  });
  assert.equal(comment.status, 201);
  assert.equal(c.services.reviewComments.list(scope).comments.length, 1);
  await c.services.pipelines.cancel(run.id);
  const removed = await c.app.request(`/api/pipeline-runs/${run.id}`, {
    method: "DELETE",
  });
  assert.equal(removed.status, 204);
  assert.deepEqual(c.services.reviewComments.list(scope), { comments: [], batches: 0 });
});
