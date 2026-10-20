import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "../helpers/mcp-pipeline-fixture.js";

const settle = (c) => c.services.pipelineQueue.changed();
const auditOf = (c, kind) =>
  c.services.audit.export().filter((event) => event.details?.kind === kind);

test("the owner queues, configures and removes items over HTTP", async (t) => {
  const c = await setup(t);
  const base = `/api/pipeline-queue/${c.project.id}`;
  const view = async () => (await c.app.request(base)).json();
  assert.deepEqual(await view(), {
    projectId: c.project.id,
    settings: { limit: 1, countParked: false },
    items: [],
  });
  assert.equal((await c.app.request("/api/pipeline-queue/missing-project")).status, 404);

  const put = (body) => c.app.request(`${base}/settings`, { method: "PUT", body });
  assert.equal((await put({ limit: 0, countParked: false })).status, 400);
  const saved = await put({ limit: 2, countParked: true });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { limit: 2, countParked: true });
  assert.deepEqual(auditOf(c, "queue-settings").at(-1).details, {
    kind: "queue-settings",
    limit: 2,
    countParked: true,
  });

  const add = (task) =>
    c.app.request(`${base}/items`, {
      method: "POST",
      body: { pipelineId: c.pipeline.id, task, externalRef: "AP-9" },
    });
  const first = await add("First");
  assert.equal(first.status, 201);
  const { item } = await first.json();
  assert.equal(item.state, "queued");
  assert.equal(item.source.kind, "user");
  await (await add("Second")).json();
  const { item: third } = await (await add("Third")).json();
  await settle(c);
  const items = (await view()).items;
  assert.deepEqual(
    items.map((i) => i.state),
    ["started", "started", "queued"],
  );
  assert.equal(items[0].run.status, "running");
  assert.equal(c.services.pipelines.get(item.id).projectId, c.project.id);
  assert.equal(c.launches.length, 2);
  // The owner's HTTP actions are audited with the item's id and project.
  const created = c.services.audit
    .export()
    .find((e) => e.action === "pipeline.created" && e.resourceId === item.id);
  assert.equal(created.projectId, c.project.id);

  const moved = await c.app.request(`${base}/items/${third.id}/move`, {
    method: "POST",
    body: { direction: "up" },
  });
  assert.equal(moved.status, 200);
  const removed = await c.app.request(`${base}/items/${third.id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  assert.ok(
    c.services.audit
      .export()
      .some((e) => e.action === "pipeline.deleted" && e.resourceId === third.id),
  );
  const retry = await c.app.request(`${base}/items/${item.id}/retry`, { method: "POST" });
  assert.equal(retry.status, 409);
  assert.equal((await view()).items.length, 2);
});

test("MCP clients queue with run_start's checks and see their own items", async (t) => {
  const c = await setup(t);
  const listed = c.tools.list(c.grant).map(([name]) => name);
  for (const name of ["queue_add", "queue_list", "queue_remove"])
    assert.ok(listed.includes(name));
  const readOnly = { ...c.grant, scopes: ["runs:read"] };
  assert.deepEqual(
    c.tools
      .list(readOnly)
      .map(([name]) => name)
      .filter((name) => name.startsWith("queue_")),
    ["queue_list"],
  );
  const input = {
    pipelineId: c.pipeline.id,
    projectId: c.project.id,
    task: "First",
    externalRef: "AP-1",
    requestId: "queue-one",
  };
  const first = await c.tools.call("queue_add", input, c.grant);
  assert.equal(first.replayed, false);
  assert.equal(first.item.task, "First");
  assert.equal(first.item.externalRef, "AP-1");
  const replay = await c.tools.call("queue_add", input, c.grant);
  assert.equal(replay.item.id, first.item.id);
  assert.equal(replay.replayed, true);
  await assert.rejects(
    c.tools.call("queue_add", { ...input, task: "Other" }, c.grant),
    (error) => error.status === 409,
  );
  // A queued request ID is not a start request ID and vice versa.
  const { externalRef: _ref, ...startInput } = input;
  await assert.rejects(
    c.tools.call("run_start", startInput, c.grant),
    (error) => error.status === 409,
  );
  await assert.rejects(
    c.tools.call("queue_add", { ...input, projectId: c.other.id }, c.grant),
    (error) => error.status === 403,
  );
  const second = await c.tools.call(
    "queue_add",
    { ...input, task: "Second", requestId: "queue-two" },
    c.grant,
  );
  await settle(c);

  // The run the queue started belongs to the grant that queued it.
  const { run } = await c.tools.call("run_get", { runId: first.item.id }, c.grant);
  assert.equal(run.status, "running");
  const foreign = {
    ...c.grant,
    id: "another-grant",
    clientId: "another-client",
    ownedRunsOnly: true,
  };
  await assert.rejects(
    c.tools.call("run_get", { runId: first.item.id }, foreign),
    (error) => error.status === 403,
  );
  const list = await c.tools.call("queue_list", { projectId: c.project.id }, c.grant);
  assert.deepEqual(
    list.items.map((i) => [i.task, i.state, i.runId]),
    [
      ["First", "started", first.item.id],
      ["Second", "queued", null],
    ],
  );
  assert.equal(list.items[0].runStatus, "running");
  // A session grant sees only what it queued; other grants see no task text.
  const own = await c.tools.call("queue_list", { projectId: c.project.id }, foreign);
  assert.equal(own.total, 0);
  const other = await c.tools.call(
    "queue_list",
    { projectId: c.project.id },
    { ...c.grant, id: "third-grant" },
  );
  assert.equal(other.total, 2);
  assert.ok(other.items.every((i) => i.task === undefined && i.externalRef === "AP-1"));

  const remove = (itemId, grant = c.grant) =>
    c.tools.call("queue_remove", { projectId: c.project.id, itemId }, grant);
  await assert.rejects(remove(second.item.id, foreign), (e) => e.status === 403);
  await assert.rejects(remove(first.item.id), (e) => e.status === 409);
  await assert.rejects(remove("missing-item"), (e) => e.status === 404);
  assert.deepEqual(await remove(second.item.id), { removed: true, id: second.item.id });
  // A removed item's request ID is spent.
  await assert.rejects(
    c.tools.call(
      "queue_add",
      { ...input, task: "Second", requestId: "queue-two" },
      c.grant,
    ),
    (error) => error.status === 409,
  );
  const events = auditOf(c, "queue").filter((e) => e.source === "mcp");
  assert.deepEqual(
    events.map((e) => [e.action, e.resourceId, e.details.grantId]),
    [
      ["pipeline.created", first.item.id, "grant-one"],
      ["pipeline.created", second.item.id, "grant-one"],
      ["pipeline.deleted", second.item.id, "grant-one"],
    ],
  );
});

test("MCP queueing may only tighten the pipeline's token budget", async (t) => {
  const c = await setup(t);
  const defs = c.services.pipelineDefinitions;
  const current = defs.getPipeline(c.pipeline.id);
  defs.savePipeline(
    { ...current, tokenBudget: 3000, expectedRevision: current.revision },
    c.pipeline.id,
  );
  const starter = {
    ...c.grant,
    scopes: c.grant.scopes.filter((scope) => scope !== "definitions:write"),
  };
  const input = {
    pipelineId: c.pipeline.id,
    projectId: c.project.id,
    task: "Budget",
    requestId: "budget",
  };
  await assert.rejects(
    c.tools.call("queue_add", { ...input, tokenBudget: 3001 }, starter),
    (error) => error.status === 403,
  );
  const { item } = await c.tools.call(
    "queue_add",
    { ...input, tokenBudget: 2000 },
    starter,
  );
  await settle(c);
  assert.equal(c.services.pipelines.get(item.id).tokenBudget, 2000);
});
