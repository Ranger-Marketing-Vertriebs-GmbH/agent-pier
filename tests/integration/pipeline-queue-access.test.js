import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "../helpers/mcp-pipeline-fixture.js";

const settle = (c) => c.services.pipelineQueue.changed();
// Stands in for the OAuth grant store: the grants that exist now, by id.
function grantStore(c, ...grants) {
  const live = new Map(grants.map((grant) => [grant.id, grant]));
  c.services.mcpAccess.grant = (id) => structuredClone(live.get(id) ?? null);
  return live;
}
// Keeps the project's only slot busy with a run started outside the queue.
const occupy = (c) =>
  c.services.pipelines.start({
    pipelineId: c.pipeline.id,
    cwd: c.app.project,
    task: "Busy",
  });
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
  grantStore(c, c.grant);
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

function lowerBudget(c, tokenBudget) {
  const defs = c.services.pipelineDefinitions;
  const current = defs.getPipeline(c.pipeline.id);
  defs.savePipeline(
    { ...current, tokenBudget, expectedRevision: current.revision },
    c.pipeline.id,
  );
}

test("MCP queueing may only tighten the pipeline's token budget, also at the start", async (t) => {
  const c = await setup(t);
  lowerBudget(c, 3000);
  const starter = {
    ...c.grant,
    scopes: c.grant.scopes.filter((scope) => scope !== "definitions:write"),
  };
  grantStore(c, c.grant);
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
  const busy = await occupy(c);
  const { item } = await c.tools.call(
    "queue_add",
    { ...input, tokenBudget: 3000 },
    starter,
  );
  // An editor's grant may keep a budget above the pipeline's.
  const { item: edited } = await c.tools.call(
    "queue_add",
    { ...input, tokenBudget: 3000, requestId: "editor" },
    c.grant,
  );
  // The owner lowers the pipeline's budget while the items wait.
  lowerBudget(c, 1000);
  await c.services.pipelines.cancel(busy.id);
  await settle(c);
  assert.equal(c.services.pipelines.get(item.id).tokenBudget, 1000);
  const listed = await c.tools.call("queue_list", { projectId: c.project.id }, starter);
  assert.deepEqual(listed.items[0].budgetCapped, { from: 3000, to: 1000 });
  const capped = c.services.audit
    .export()
    .find((e) => e.resourceId === item.id && e.details?.kind === "budget");
  assert.deepEqual(capped.details, {
    kind: "budget",
    from: 3000,
    to: 1000,
    usedTokens: 0,
  });
  await c.services.pipelines.cancel(item.id);
  await settle(c);
  assert.equal(c.services.pipelines.get(edited.id).tokenBudget, 3000);
});

test("a revoked or narrowed grant's queued items fail with the reason and never start", async (t) => {
  const c = await setup(t);
  const second = { ...c.grant, id: "grant-two", clientId: "client-two" };
  const live = grantStore(c, c.grant, second);
  const busy = await occupy(c);
  const input = { pipelineId: c.pipeline.id, projectId: c.project.id, task: "Revoked" };
  const { item: revoked } = await c.tools.call(
    "queue_add",
    { ...input, requestId: "revoked" },
    c.grant,
  );
  const { item: narrowed } = await c.tools.call(
    "queue_add",
    { ...input, task: "Narrowed", requestId: "narrowed" },
    second,
  );
  const { item: kept } = await c.tools.call(
    "queue_add",
    { ...input, task: "Kept", requestId: "kept" },
    second,
  );
  const launches = c.launches.length;
  live.delete("grant-one");
  // The second grant loses the project, then gets it back before its next item.
  live.set("grant-two", { ...second, projectIds: [] });
  await c.services.pipelines.cancel(busy.id);
  await settle(c);
  const items = c.services.pipelineQueue.view(c.project.id).items;
  const state = (id) => items.find((i) => i.id === id);
  assert.equal(state(revoked.id).state, "failed");
  assert.equal(
    state(revoked.id).error,
    "Der Zugang, der diesen Eintrag eingereiht hat, ist widerrufen oder beendet. Der Eintrag startet nicht.",
  );
  assert.equal(state(narrowed.id).state, "failed");
  assert.equal(state(kept.id).state, "failed");
  assert.equal(c.launches.length, launches);
  assert.throws(() => c.services.pipelines.get(revoked.id), { status: 404 });
  const failures = c.services.audit
    .export()
    .filter((e) => e.action === "pipeline.failed")
    .map((e) => [e.resourceId, e.details.failReason]);
  assert.deepEqual(failures, [
    [revoked.id, "grant-revoked"],
    [narrowed.id, "grant-narrowed"],
    [kept.id, "grant-narrowed"],
  ]);
  // MCP clients read the reason in English.
  live.set("grant-two", second);
  const listed = await c.tools.call("queue_list", { projectId: c.project.id }, second);
  assert.equal(
    listed.items.find((i) => i.id === narrowed.id).error,
    "The access that queued this item no longer allows this start. The item will not start.",
  );
  // Once the grant allows it again, the owner can start the item again.
  c.services.pipelineQueue.retry(c.project.id, kept.id);
  await settle(c);
  assert.equal(c.services.pipelines.get(kept.id).task, "Kept");
});

test("a refused queue_add leaves its request ID unused", async (t) => {
  const c = await setup(t);
  grantStore(c, c.grant);
  const input = {
    pipelineId: c.pipeline.id,
    projectId: c.project.id,
    task: "Bidi",
    requestId: "refused",
  };
  await assert.rejects(
    c.tools.call("queue_add", { ...input, externalRef: "AP-1\u202egnp.exe" }, c.grant),
    (error) => error.status === 400,
  );
  const { item, replayed } = await c.tools.call(
    "queue_add",
    { ...input, externalRef: "AP-1" },
    c.grant,
  );
  assert.equal(replayed, false);
  assert.equal(item.externalRef, "AP-1");
});
