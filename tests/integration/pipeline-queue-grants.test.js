import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { issue, connect, selection } from "../helpers/session-mcp.js";

// A one-stage pipeline of the local Codex account and synthetic engine ports.
function prepare(f) {
  const a = f.application;
  const project = a.memory.projects().projects[0];
  const launches = [];
  a.pipelines.workspace = {
    async prepare({ runId }) {
      const cwd = path.join(f.root, runId);
      await fs.mkdir(cwd);
      return { cwd, projectId: project.id, projectRoot: f.project, branch: runId };
    },
  };
  a.pipelines.driver = {
    async start(input) {
      launches.push(input);
      return { sessionId: input.sessionId };
    },
    async inspect() {
      return { status: "running" };
    },
    async cancel() {},
  };
  const profile = a.pipelineDefinitions.saveProfile({
    name: "Fixture",
    enabled: true,
    phaseKey: "implementation",
    config: {
      accountId: "local-codex",
      cliTool: "codex",
      models: { available: [""], default: "" },
      prompts: { role: "", kickoff: "Fixture", params: [] },
      permissions: { mode: "never" },
      run: { autonomous: true },
    },
  });
  const pipeline = a.pipelineDefinitions.savePipeline({
    name: "Fixture",
    graph: {
      entry: "build",
      nodes: [{ id: "build", kind: "profile", profileId: profile.id }],
      edges: [],
    },
  });
  return { a, project, pipeline, launches };
}

test("a session whose access was revoked never starts what it queued", async (t) => {
  const f = await applicationFixture(t);
  const choices = selection(["catalog:read", "runs:read", "runs:start", "runs:cancel"]);
  const owner = await issue(f, { choices });
  const peer = await issue(f, { choices });
  // The sessions registered the project they work in.
  const { a, project, pipeline, launches } = prepare(f);
  const ownerClient = await connect(t, f, owner),
    peerClient = await connect(t, f, peer);
  // The project's only slot is busy, so both items wait.
  const busy = await a.pipelines.start({
    pipelineId: pipeline.id,
    cwd: f.project,
    task: "Busy",
  });
  const queue = (client, task) =>
    client.callTool({
      name: "queue_add",
      arguments: {
        pipelineId: pipeline.id,
        projectId: project.id,
        task,
        requestId: task,
      },
    });
  const revoked = (await queue(ownerClient, "Owner")).structuredContent.item;
  const kept = (await queue(peerClient, "Peer")).structuredContent.item;
  assert.equal(revoked.state, "queued");
  await a.sessionMcp.revoke(owner.session.id);
  const before = launches.length;
  await a.pipelines.cancel(busy.id);
  await a.pipelineQueue.changed();
  const items = a.pipelineQueue.view(project.id).items;
  assert.deepEqual(
    items.map((i) => [i.task, i.state]),
    [
      ["Owner", "failed"],
      ["Peer", "started"],
    ],
  );
  assert.equal(launches.length, before + 1);
  assert.throws(() => a.pipelines.get(revoked.id), { status: 404 });
  // The live session's run belongs to it.
  const run = await peerClient.callTool({
    name: "run_get",
    arguments: { runId: kept.id },
  });
  assert.equal(run.structuredContent.run.status, "running");
  const failed = a.audit
    .export()
    .find((e) => e.action === "pipeline.failed" && e.resourceId === revoked.id);
  assert.equal(failed.details.failReason, "grant-revoked");
  assert.equal(failed.source, "system");
});
