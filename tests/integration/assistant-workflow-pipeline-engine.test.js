import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { fixture as pipelineFixture } from "../helpers/pipeline-engine.js";
import { AssistantWorkflows } from "../../server/features/assistants/assistant-workflows.js";

async function fixture(t) {
  const f = await workflowFixture(t),
    p = pipelineFixture(t);
  const template = p.definitions.snapshot().profiles.profile;
  f.profile.config = { ...template.config, accountId: "account" };
  p.definitions.snapshot = () => ({
    pipeline: structuredClone(f.pipeline),
    profiles: { profile: structuredClone(f.profile) },
  });
  const prepare = p.workspace.prepare;
  p.workspace.prepare = async (input) => ({
    ...(await prepare(input)),
    projectId: f.project.id,
  });
  f.services.pipelines = p.engine;
  const cli = path.join(p.dir, "fake-cli.cjs");
  fs.writeFileSync(
    cli,
    `
    const fs = require("node:fs");
    fs.writeFileSync("result.txt", "Disposable pipeline artifact");
    fs.writeFileSync(process.argv[2], JSON.stringify({
      result: "pass", summary: "Fixture task completed",
      artifacts: [{path: "result.txt", label: "Result"}]
    }));
  `,
  );
  const start = p.driver.start;
  p.driver.start = async (input) => {
    const receipt = await start(input);
    await promisify(execFile)(process.execPath, [cli, input.verdictPath], {
      cwd: input.cwd,
      env: { PATH: path.dirname(process.execPath) },
    });
    return receipt;
  };
  f.workflows.access.save(f.id, { ...f.policy, autonomous: true }, 0);
  return { ...f, p };
}

test("assistant coding recovers a real persisted pipeline after lost acknowledgement and restart", async (t) => {
  const f = await fixture(t);
  const start = f.p.engine.start.bind(f.p.engine);
  f.p.engine.start = async (...args) => {
    await start(...args);
    throw Object.assign(Error("Lost start response after persistence"), { status: 409 });
  };
  const input = {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Produce the disposable artifact",
  };
  const inv = await f.invocation();
  const proposal = await f.workflows.invoke(inv, input);
  await f.workflows.tick();
  const running = f.workflows.get(proposal.id);
  assert.equal(running.state, "running");
  assert.equal(f.p.launches.length, 1);
  assert.equal(f.p.engine.get(running.runId).projectId, f.project.id);
  assert.equal(f.p.engine.get(running.runId).pipelineId, f.pipeline.id);
  assert.equal((await f.workflows.invoke(inv, input)).id, proposal.id);

  const launch = f.p.launches[0];
  f.p.outcomes.set(launch.sessionId, { status: "completed", exitCode: 0 });
  await f.workflows.close();
  await f.p.restart();
  f.services.pipelines = f.p.engine;
  const recovered = new AssistantWorkflows({ services: f.services, autoStart: false });
  t.after(() => recovered.close());
  await recovered.tick();
  await recovered.tick();
  assert.equal(recovered.get(proposal.id).state, "completed");
  assert.equal(recovered.get(proposal.id).runId, running.runId);
  assert.equal(f.p.engine.list().total, 1);
  assert.equal(f.p.launches.length, 1);
  const artifacts = await recovered.coding.call(f.id, proposal.id, "run_artifacts", {
    nodeId: "code",
  });
  assert.match(JSON.stringify(artifacts), /result.txt/);
});

test("assistant cancellation reaches the real engine and current access revocation blocks run tools", async (t) => {
  const f = await fixture(t);
  const proposal = await f.workflows.invoke(await f.invocation(), {
    action: "coding_start",
    projectId: f.project.id,
    pipelineId: f.pipeline.id,
    task: "Run a cancellable task",
  });
  await f.workflows.tick();
  const action = f.workflows.get(proposal.id);
  assert.equal(action.state, "running");
  await f.workflows.coding.call(f.id, action.id, "run_cancel");
  await f.workflows.tick();
  assert.equal(f.p.engine.get(action.runId).status, "cancelled");
  assert.equal(f.workflows.get(action.id).state, "cancelled");
  f.workflows.access.save(f.id, { ...f.policy, projectIds: [] }, 1);
  await assert.rejects(f.workflows.coding.call(f.id, action.id, "run_get"), {
    status: 403,
  });
  assert.equal(f.p.engine.list().total, 1);
});
