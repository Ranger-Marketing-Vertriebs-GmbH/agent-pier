import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { McpTools } from "../../server/features/mcp/tool-service.js";
import { SessionMcp } from "../../server/features/mcp/session-integration.js";
import { orderView } from "../../server/features/autopilot/order-view.js";
import { problem, writePrivate } from "../../server/lib/storage.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-composer-mcp-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const projectId = "project-one";
  const ref = {
    id: "order-one",
    projectId,
    managed: true,
    projectRoot: dataDir,
    resources: {},
  };
  const second = { ...ref, id: "order-two", resources: {} };
  const starts = new Map(),
    items = new Map(),
    sessions = new Map();
  let authorized = true;
  const pipeline = {
    id: "pipe",
    graph: {
      entry: "build",
      nodes: [{ id: "build", kind: "profile", profileId: "profile" }],
      edges: [],
    },
  };
  const profile = {
    id: "profile",
    config: { accountId: "local-codex", models: { default: "x" } },
  };
  const services = {
    config: { dataDir },
    audit: { append() {} },
    mutationBarrier: { run: (fn) => fn() },
    memory: { project: () => ({ cwd: dataDir }), reboundTo: () => null },
    autopilot: {
      sessionOrder: (id) => sessions.get(id),
      sessionPolicy: (id) => ({
        orderId: sessions.get(id)?.id,
        manualPaused: !authorized,
        implementationAuthorized: authorized,
        allowMerge: false,
      }),
      currentSessionId: (id) =>
        [ref, second].find((r) => r.id === id)?.resources.sessionId,
      assertStart(id, project) {
        const order = sessions.get(id);
        if (
          !authorized ||
          !order ||
          order.resources.sessionId !== id ||
          project !== order.projectId
        )
          throw problem("Order paused or unavailable", 403);
      },
    },
    pipelineDefinitions: { getPipeline: () => pipeline, getProfile: () => profile },
    pipelines: {
      start(_input, { id }) {
        const run = {
          id,
          projectId,
          pipelineId: pipeline.id,
          nodes: [],
          status: "running",
        };
        starts.set(id, run);
        return run;
      },
      get(id) {
        if (!starts.has(id)) throw problem("missing", 404);
        return starts.get(id);
      },
      store: { all: () => [...starts.values()], get: (id) => starts.get(id) },
    },
    pipelineQueue: {
      find: (id) => items.get(id),
      check() {},
      add(projectId, fields, { id, source }) {
        const item = {
          projectId,
          id,
          state: "queued",
          source,
          ...fields,
          tokenBudget: fields.tokenBudget ?? null,
        };
        items.set(id, item);
        return item;
      },
      item: (_project, id) => items.get(id),
      view: () => ({ items: [...items.values()] }),
    },
  };
  services.sessionMcp = Object.assign(Object.create(SessionMcp.prototype), {
    services,
    dataDir,
  });
  const open = () => {
    const tools = new McpTools(services, { scope: async () => ({ id: projectId }) });
    services.mcpTools = tools;
    t.after(() => tools.close());
    return tools;
  };
  const issue = (order) => {
    const id = randomUUID(),
      generation = randomUUID(),
      secret = randomBytes(32).toString("hex");
    if (order.resources.sessionId)
      (order.resources.retiredSessionIds ??= []).push(order.resources.sessionId);
    order.resources.sessionId = id;
    sessions.set(id, order);
    const grant = {
      id: `session-${id}`,
      clientId: `session-${id}`,
      sessionId: id,
      scopes: ["runs:start", "runs:read"],
      ownedRunsOnly: true,
      projectIds: [projectId],
      accountIds: ["local-codex"],
      connectionIds: [],
    };
    writePrivate(path.join(dataDir, "session-mcp", id, "active.json"), {
      generation,
      token: secret,
      tool: "codex",
      accountId: "local-codex",
      grant,
    });
    writePrivate(path.join(dataDir, "sessions", id + ".json"), {
      id,
      tool: "codex",
      accountId: "local-codex",
      status: "running",
      agentpierTools: { enabled: true, generation },
    });
    const read = () =>
      services.sessionMcp.check(`${id}.${generation}.${secret}`).extra.grant;
    return {
      read,
      id,
      call: (name, input) => services.mcpTools.call(name, input, read(), read),
    };
  };
  const args = {
    pipelineId: pipeline.id,
    projectId,
    requestId: "stable-request",
    task: "Build",
  };
  return {
    ref,
    second,
    args,
    services,
    issue,
    open,
    starts,
    authorize: (value) => {
      authorized = value;
    },
  };
}

test("a recovered Composer reconciles uncheckpointed starts and replays its receipt across restart", async (t) => {
  const f = fixture(t),
    tools = f.open(),
    old = f.issue(f.ref);
  const policy = await old.call("autopilot_policy", {});
  assert.equal(policy.orderId, f.ref.id);
  assert.equal(policy.allowMerge, false);
  const first = await old.call("run_start", f.args);
  const other = f.issue(f.second);
  assert.equal((await other.call("runs_list", {})).total, 0);
  tools.close();
  f.open();
  const current = f.issue(f.ref);
  assert.throws(old.read, { status: 403 });
  assert.notEqual(current.id, old.id);
  const listed = (await current.call("runs_list", {})).items[0];
  assert.equal(listed.id, first.run.id);
  assert.equal(listed.requestId, f.args.requestId);
  f.authorize(false);
  assert.equal((await current.call("run_start", f.args)).replayed, true);
  const denied = { ...f.args, requestId: "new" };
  await assert.rejects(current.call("run_start", denied), { status: 403 });
  await assert.rejects(current.call("queue_add", denied), { status: 403 });
  const model = await orderView(
    { ref: f.ref, document: { batches: [{ id: "batch", requestId: f.args.requestId }] } },
    f.services,
  );
  assert.equal(model.runs[0].id, first.run.id);
  assert.equal(model.batches[0].runs[0].id, first.run.id);
  assert.equal(model.hasOpenWork, true);
  assert.equal(f.starts.size, 1);
});

test("a queued Composer run uses the live replacement grant and the order's current execution policy", async (t) => {
  const f = fixture(t),
    tools = f.open(),
    original = f.issue(f.ref);
  const { item } = await original.call("queue_add", f.args);
  const queued = f.services.pipelineQueue.find(item.id);
  const current = f.issue(f.ref);
  assert.equal(
    (await current.call("queue_list", { projectId: f.args.projectId })).items[0].task,
    f.args.task,
  );
  assert.equal(
    (await current.call("queue_list", { projectId: f.args.projectId })).items[0]
      .requestId,
    f.args.requestId,
  );
  assert.equal((await current.call("queue_add", f.args)).replayed, true);
  assert.equal(
    (await f.issue(f.second).call("queue_list", { projectId: f.args.projectId })).total,
    0,
  );
  const model = await orderView({ ref: f.ref, document: {} }, f.services);
  assert.equal(model.startReceipts[0].queueState, "queued");
  assert.equal(model.hasOpenWork, true);
  assert.deepEqual(tools.queuedStart(queued), { tokenBudget: null });
  f.authorize(false);
  assert.throws(() => tools.queuedStart(queued), { status: 403 });
  f.authorize(true);
  f.services.sessionMcp.discard(current.id);
  assert.throws(() => tools.queuedStart(queued), { status: 403 });
});
