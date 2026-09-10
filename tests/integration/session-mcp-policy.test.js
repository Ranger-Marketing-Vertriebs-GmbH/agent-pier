import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { issue, connect, selection } from "../helpers/session-mcp.js";
import { historicalOnly } from "../../server/features/operations/restore-data.js";
import { capture } from "../../server/features/operations/snapshot.js";

async function pipeline(f, accountId = "local-codex", publish = false) {
  const a = f.application;
  const profile = a.pipelineDefinitions.saveProfile({
    name: "Fixture",
    enabled: true,
    phaseKey: "implementation",
    config: {
      accountId,
      cliTool: accountId.slice(6),
      models: { available: [""], default: "" },
      prompts: { role: "", kickoff: "Fixture", params: [] },
      permissions: { mode: accountId === "local-codex" ? "never" : "auto" },
      run: { autonomous: true },
    },
  });
  return a.pipelineDefinitions.savePipeline({
    name: "Fixture",
    graph: {
      entry: "build",
      nodes: [
        { id: "build", kind: "profile", profileId: profile.id },
        ...(publish ? [{ id: "pr", kind: "createPr" }] : []),
      ],
      edges: publish ? [{ from: "build", to: "pr", condition: "pass" }] : [],
    },
  });
}

test("internal starts use the same resource/publication checks, idempotency and own-run isolation", async (t) => {
  const f = await applicationFixture(t);
  const a = f.application;
  const choices = selection(["catalog:read", "runs:read", "runs:start", "runs:cancel"]);
  const owner = await issue(f, { choices });
  const peer = await issue(f, { choices });
  const client = await connect(t, f, owner),
    other = await connect(t, f, peer);
  const project = a.memory.projects().projects[0];
  const allowed = await pipeline(f),
    foreign = await pipeline(f, "local-claude"),
    publishing = await pipeline(f, "local-codex", true);
  let starts = 0;
  a.pipelines.workspace = {
    async prepare({ runId }) {
      const cwd = path.join(f.root, runId);
      await fs.mkdir(cwd);
      return {
        cwd,
        projectId: project.id,
        projectRoot: f.home,
        branch: `fixture/${runId}`,
      };
    },
  };
  a.pipelines.driver = {
    async start(input) {
      starts++;
      return { sessionId: input.sessionId };
    },
    async inspect() {
      return { status: "running" };
    },
    async cancel() {},
  };
  const start = (pipelineId, extra = {}) =>
    client.callTool({
      name: "run_start",
      arguments: {
        pipelineId,
        projectId: project.id,
        task: "Fixture",
        requestId: "same-request",
        ...extra,
      },
    });
  assert.equal((await start(foreign.id)).isError, true);
  assert.equal((await start(publishing.id)).isError, true);
  assert.equal((await start(allowed.id, { projectId: "outside" })).isError, true);
  assert.equal(starts, 0);
  const first = await start(allowed.id);
  assert.equal(first.isError, undefined, JSON.stringify(first));
  const runId = first.structuredContent.run.id;
  assert.equal((await start(allowed.id)).structuredContent.run.id, runId);
  assert.equal(starts, 1);
  assert.equal((await start(allowed.id, { task: "Changed" })).isError, true);
  assert.equal(
    (await other.callTool({ name: "runs_list", arguments: {} })).structuredContent.items
      .length,
    0,
  );
  for (const name of ["run_get", "run_cancel"])
    assert.equal((await other.callTool({ name, arguments: { runId } })).isError, true);
  const unrestricted = await issue(f, { choices: true });
  const fullClient = await connect(t, f, unrestricted);
  assert.equal(
    (await fullClient.callTool({ name: "run_get", arguments: { runId } })).isError,
    undefined,
  );
  const record = a.pipelines.get(runId);
  assert.equal(record.status, "running");
  await a.sessionMcp.revoke(owner.session.id);
  assert.equal(
    a.pipelines.get(runId).status,
    "running",
    "revocation does not cancel independent runs",
  );
  assert.equal(
    (await fullClient.callTool({ name: "run_cancel", arguments: { runId } })).isError,
    undefined,
  );
});

test("a queued mutation rechecks revocation after the snapshot barrier", async (t) => {
  const f = await applicationFixture(t);
  const a = f.application;
  const issued = await issue(f, {
    choices: selection(["catalog:read", "definitions:write"]),
  });
  const grant = a.sessionMcp.check(issued.token).extra.grant;
  const client = await connect(t, f, issued);
  let release, entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const snapshot = a.mutationBarrier.snapshot(async () => {
    entered();
    await gate;
  });
  await ready;
  // call() reaches the barrier synchronously before its continuation resolves.
  const mutation = a.mcpTools.call(
    "profile_save",
    { profile: {} },
    grant,
    () => a.sessionMcp.check(issued.token).extra.grant,
  );
  const denied = assert.rejects(mutation, { status: 403 });
  a.sessionMcp.discard(issued.session.id);
  release();
  await snapshot;
  await denied;
  await assert.rejects(client.listTools());
});

test("private capabilities are excluded from snapshots and linked storage is rejected", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f);
  const snapshot = capture({
    dataDir: f.dataDir,
    home: f.home,
    includeHistory: true,
    withCredentials: false,
  });
  assert.equal(JSON.stringify(snapshot).includes(issued.token.split(".").at(-1)), false);
  assert.equal(JSON.stringify(snapshot).includes("session-mcp/"), false);
  const directory = path.join(f.dataDir, "session-mcp", issued.session.id);
  await fs.rename(directory, directory + "-original");
  await fs.symlink(directory + "-original", directory);
  assert.throws(() => f.application.sessionMcp.check(issued.token), { status: 403 });
  await fs.unlink(directory);
  await fs.rename(directory + "-original", directory);
});

test("restored historical sessions cannot retain internal MCP authorization", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f);
  const restored = path.join(f.root, "restored");
  await fs.mkdir(path.join(restored, "sessions"), { recursive: true });
  const file = path.join(restored, "sessions", `${issued.session.id}.json`);
  await fs.writeFile(file, JSON.stringify(issued.session));
  historicalOnly(restored);
  const session = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(session.status, "stopped");
  assert.equal(session.agentpierTools, undefined);
  assert.equal(session.imported.historyOnly, true);
});

test("explicit revocation wins over a reload with a stale enabled selection, including after restart", async (t) => {
  const f = await applicationFixture(t);
  const issued = await issue(f);
  await f.application.sessionMcp.revoke(issued.session.id);
  await f.restart();
  const launch = await f.application.sessionMcp.prepare({
    id: issued.session.id,
    account: f.application.accounts.get("local-codex"),
    cwd: f.home,
    launch: { args: [], env: {} },
    selection: issued.session.agentpierTools.selection,
    replace: true,
  });
  assert.equal(launch.agentpierTools.enabled, false);
  assert.deepEqual(launch.args, []);
  assert.throws(() => f.application.sessionMcp.check(issued.token), { status: 403 });
});

test("one-checkbox access exposes all tools and includes projects added after launch", async (t) => {
  const f = await applicationFixture(t);
  const a = f.application;
  const issued = await issue(f, { choices: true });
  const client = await connect(t, f, issued);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "projects_list",
    "profile_save",
    "pipeline_save",
    "run_start",
    "run_cancel",
  ])
    assert.ok(tools.includes(name), name);
  const directory = path.join(f.root, "later-project");
  await fs.mkdir(directory);
  const project = await a.memory.register(directory);
  const projects = await client.callTool({ name: "projects_list", arguments: {} });
  assert.ok(projects.structuredContent.items.some((item) => item.id === project.id));
  const grant = a.sessionMcp.check(issued.token).extra.grant;
  assert.equal(grant.ownedRunsOnly, false);
  assert.ok(grant.scopes.includes("runs:publish"));
  assert.deepEqual(
    grant.accountIds,
    a.sessionMcp.resources().accounts.map((a) => a.id),
  );
  assert.deepEqual(
    grant.connectionIds,
    a.sessionMcp.resources().connections.map((c) => c.id),
  );
});
