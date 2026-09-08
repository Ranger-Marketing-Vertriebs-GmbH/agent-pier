import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
import { applicationFixture } from "../helpers/application.js";
import { PipelineEngine } from "../../server/features/pipelines/pipeline-engine.js";
import { McpTools } from "../../server/features/mcp/tool-service.js";

async function setup(t) {
  const app = await applicationFixture(t);
  const services = app.application;
  const project = await services.memory.register(app.home);
  const otherPath = path.join(app.root, "other");
  await fs.mkdir(otherPath);
  const other = await services.memory.register(otherPath);
  const launches = [];
  services.pipelines.workspace = {
    async prepare({ runId }) {
      const cwd = path.join(app.root, runId);
      await fs.mkdir(cwd);
      return {
        cwd,
        projectId: project.id,
        projectRoot: app.home,
        branch: `agentpier/${runId}`,
      };
    },
  };
  services.pipelines.driver = {
    async start(input) {
      launches.push(input);
      return { sessionId: input.sessionId };
    },
    async inspect() {
      return { status: "running" };
    },
    async cancel() {},
  };
  const tools = new McpTools(services);
  t.after(() => tools.close());
  const grant = {
    id: "grant-one",
    clientId: "client-one",
    scopes: [
      "catalog:read",
      "definitions:write",
      "runs:read",
      "runs:start",
      "runs:cancel",
    ],
    projectIds: [project.id],
    accountIds: ["local-codex"],
    connectionIds: [],
  };
  const body = {
    name: "Build",
    description: "",
    enabled: true,
    phaseKey: "implementation",
    config: {
      accountId: "local-codex",
      cliTool: "codex",
      models: { available: [""], default: "" },
      prompts: { role: "", kickoff: "Build", params: [] },
      permissions: { mode: "never" },
      run: { autonomous: true },
    },
  };
  const profile = services.pipelineDefinitions.saveProfile(body);
  const pipeline = services.pipelineDefinitions.savePipeline({
    name: "Build",
    description: "",
    graph: {
      entry: "build",
      nodes: [{ id: "build", kind: "profile", profileId: profile.id }],
      edges: [],
    },
  });
  return {
    app,
    services,
    tools,
    grant,
    project,
    other,
    profile,
    pipeline,
    body,
    launches,
  };
}

test("MCP lists only granted projects/accounts and rejects cross-scope operations", async (t) => {
  const c = await setup(t);
  const listed = await c.tools.call("projects_list", {}, c.grant);
  assert.deepEqual(
    listed.items.map((p) => p.id),
    [c.project.id],
  );
  const accounts = await c.tools.call("accounts_list", {}, c.grant);
  assert.deepEqual(
    accounts.items.map((a) => a.id),
    ["local-codex"],
  );
  await assert.rejects(
    c.tools.call(
      "profile_save",
      { profile: c.body },
      { ...c.grant, scopes: ["catalog:read"] },
    ),
    (error) => error.status === 403,
  );
  await assert.rejects(
    c.tools.call(
      "profile_save",
      {
        profile: {
          ...c.body,
          config: {
            ...c.body.config,
            accountId: "local-claude",
            cliTool: "claude",
            permissions: { mode: "auto" },
          },
        },
      },
      c.grant,
    ),
    (error) => error.status === 403,
  );
  await assert.rejects(
    c.tools.call(
      "run_start",
      {
        pipelineId: c.pipeline.id,
        projectId: c.other.id,
        task: "test",
        requestId: "foreign",
      },
      c.grant,
    ),
    (error) => error.status === 403,
  );
  await assert.rejects(
    c.tools.call(
      "run_start",
      {
        pipelineId: c.pipeline.id,
        projectId: c.project.id,
        cwd: c.app.home,
        task: "test",
        requestId: "raw-path",
      },
      c.grant,
    ),
    (error) => error.status === 400,
  );
  assert.equal(c.launches.length, 0);
});

test("MCP saves real definitions with revision conflicts and validates publication authority", async (t) => {
  const c = await setup(t);
  const created = await c.tools.call(
    "profile_save",
    { profile: { ...c.body, name: "Agent profile" } },
    c.grant,
  );
  assert.equal(
    c.services.pipelineDefinitions.getProfile(created.profile.id).name,
    "Agent profile",
  );
  await assert.rejects(
    c.tools.call(
      "profile_save",
      { id: created.profile.id, profile: { ...c.body, expectedRevision: 99 } },
      c.grant,
    ),
    (error) => error.status === 409,
  );
  const definition = {
    name: "Publish",
    description: "",
    graph: {
      entry: "build",
      nodes: [
        { id: "build", kind: "profile", profileId: c.profile.id },
        { id: "pr", kind: "createPr" },
      ],
      edges: [{ from: "build", to: "pr", condition: "default" }],
    },
  };
  await assert.rejects(
    c.tools.call("pipeline_save", { pipeline: definition }, c.grant),
    (error) => error.status === 403,
  );
  const saved = await c.tools.call(
    "pipeline_save",
    { pipeline: definition },
    { ...c.grant, scopes: [...c.grant.scopes, "runs:publish"] },
  );
  await assert.rejects(
    c.tools.call(
      "run_start",
      {
        pipelineId: saved.pipeline.id,
        projectId: c.project.id,
        task: "test",
        requestId: "publish",
      },
      c.grant,
    ),
    (error) => error.status === 403,
  );
  await assert.rejects(
    c.tools.call("run_gate", {}, c.grant),
    (error) => error.status === 404,
  );
});

test("MCP duplicate concurrent starts and reconnection refer to one durable run", async (t) => {
  const c = await setup(t);
  const input = {
    pipelineId: c.pipeline.id,
    projectId: c.project.id,
    task: "test",
    requestId: "one-start",
  };
  const [first, second] = await Promise.all([
    c.tools.call("run_start", input, c.grant),
    c.tools.call("run_start", input, c.grant),
  ]);
  assert.equal(first.run.id, second.run.id);
  assert.equal(c.launches.length, 1);
  c.tools.close();
  const reconnect = new McpTools(c.services);
  t.after(() => reconnect.close());
  const replay = await reconnect.call("run_start", input, c.grant);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(c.services.pipelines.store.all().length, 1);
  await assert.rejects(
    reconnect.call("run_start", { ...input, task: "different" }, c.grant),
    (error) => error.status === 409,
  );
  const foreign = { ...c.grant, id: "another-grant" };
  await assert.rejects(
    reconnect.call("run_cancel", { runId: first.run.id }, foreign),
    (error) => error.status === 403,
  );
  const cancelled = await reconnect.call("run_cancel", { runId: first.run.id }, c.grant);
  assert.equal(cancelled.run.status, "cancelled");
});

test("MCP frozen-run reads and lists reject ungranted accounts and projects", async (t) => {
  const c = await setup(t);
  const { run } = await c.tools.call(
    "run_start",
    {
      pipelineId: c.pipeline.id,
      projectId: c.project.id,
      task: "test",
      requestId: "visibility",
    },
    c.grant,
  );
  const reduced = { ...c.grant, accountIds: [] };
  await assert.rejects(
    c.tools.call("run_get", { runId: run.id }, reduced),
    (error) => error.status === 403,
  );
  assert.deepEqual((await c.tools.call("runs_list", {}, reduced)).items, []);
  await assert.rejects(
    c.tools.call(
      "run_artifacts",
      { runId: run.id, nodeId: "build" },
      { ...c.grant, projectIds: [] },
    ),
    (error) => error.status === 403,
  );
  const events = c.services.audit.export();
  assert.ok(events.some((e) => e.source === "mcp" && e.details.grantId === c.grant.id));
  assert.doesNotMatch(JSON.stringify(events), /one-start|visibility/);
});

test("MCP refuses a registered path whose project identity changed before reservation", async (t) => {
  const c = await setup(t);
  await execute("git", ["init", "--quiet", c.app.home]);
  const changed = await c.services.memory.register(c.app.home);
  assert.notEqual(changed.id, c.project.id);
  await assert.rejects(
    c.tools.call(
      "run_start",
      {
        pipelineId: c.pipeline.id,
        projectId: c.project.id,
        task: "test",
        requestId: "stale-project",
      },
      c.grant,
    ),
    (error) => error.status === 409,
  );
  assert.equal(c.services.pipelines.store.all().length, 0);
  assert.equal(
    c.tools.requests.get(c.grant.id, "stale-project", {
      pipelineId: c.pipeline.id,
      projectId: c.project.id,
      task: "test",
      baseBranch: null,
    }),
    undefined,
  );
  assert.equal(c.launches.length, 0);
});

test("MCP persists the expected project and refuses a mismatched prepared workspace before launch", async (t) => {
  const c = await setup(t);
  c.services.pipelines.workspace.prepare = async () => ({
    cwd: c.app.home,
    projectId: c.other.id,
    projectRoot: c.app.home,
    branch: "ungranted",
  });
  const result = await c.tools.call(
    "run_start",
    {
      pipelineId: c.pipeline.id,
      projectId: c.project.id,
      task: "test",
      requestId: "changed-during-preparation",
    },
    c.grant,
  );
  assert.equal(result.run.status, "failed");
  assert.equal(c.launches.length, 0);
  const stored = c.services.pipelines.store.get(result.run.id);
  assert.equal(stored.expectedProjectId, c.project.id);
  assert.equal(stored.workspace, null);
  assert.match(stored.failDetail, /project/i);
});

test("Recovered provisioning retains its project constraint before a native launch", async (t) => {
  const c = await setup(t);
  c.services.pipelines.workspace.prepare = async () => ({
    cwd: c.app.home,
    projectId: c.other.id,
    projectRoot: c.app.home,
    branch: "ungranted",
  });
  const result = await c.tools.call(
    "run_start",
    {
      pipelineId: c.pipeline.id,
      projectId: c.project.id,
      task: "test",
      requestId: "recover-project",
    },
    c.grant,
  );
  const interrupted = c.services.pipelines.store.get(result.run.id);
  interrupted.status = "running";
  interrupted.phase = "provisioning";
  c.services.pipelines.store.save(interrupted);
  await c.services.pipelines.close();
  const recovered = new PipelineEngine({
    dataDir: c.app.dataDir,
    definitions: c.services.pipelineDefinitions,
    workspace: c.services.pipelines.workspace,
    driver: c.services.pipelines.driver,
    pollIntervalMs: 0,
  });
  t.after(() => recovered.close());
  await recovered.recover();
  assert.equal(recovered.get(result.run.id).status, "failed");
  assert.equal(recovered.get(result.run.id).expectedProjectId, c.project.id);
  assert.equal(c.launches.length, 0);
});

test("Owner HTTP request bodies cannot inject internal run IDs or project constraints", async (t) => {
  const c = await setup(t);
  const response = await c.app.request("/api/pipeline-runs", {
    method: "POST",
    body: {
      pipelineId: c.pipeline.id,
      cwd: c.app.home,
      task: "test",
      id: "injected-run",
      expectedProjectId: c.other.id,
    },
  });
  assert.equal(response.status, 201);
  const { run } = await response.json();
  assert.notEqual(run.id, "injected-run");
  assert.equal(run.expectedProjectId, undefined);
  assert.equal(run.projectId, c.project.id);
  assert.equal(c.launches.length, 1);
});

test("MCP retries return an existing frozen run even after the source project changes", async (t) => {
  const c = await setup(t);
  const input = {
    pipelineId: c.pipeline.id,
    projectId: c.project.id,
    task: "test",
    requestId: "existing-before-project-change",
  };
  const first = await c.tools.call("run_start", input, c.grant);
  await execute("git", ["init", "--quiet", c.app.home]);
  const replay = await c.tools.call("run_start", input, c.grant);
  assert.equal(replay.run.id, first.run.id);
  assert.equal(replay.replayed, true);
  assert.equal(c.launches.length, 1);
});
