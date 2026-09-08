import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applicationFixture } from "../helpers/application.js";
const exec = promisify(execFile);

async function waitFor(app, id, status) {
  const deadline = Date.now() + 15000;
  let run;
  do {
    const response = await app.request(`/api/pipeline-runs/${id}`);
    assert.equal(response.status, 200);
    run = (await response.json()).run;
    if (run.status === status) return run;
    if (["failed", "cancelled"].includes(run.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`Pipeline did not reach ${status}: ${JSON.stringify(run)}`);
}

test("public pipeline lifecycle drives a native turn, verification, evidence and durable human approval", async (t) => {
  const app = await applicationFixture(t);
  const env = { PATH: process.env.PATH, HOME: app.home, GIT_CONFIG_NOSYSTEM: "1" };
  const git = async (...args) =>
    (await exec("git", args, { cwd: app.home, env })).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Pipeline fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(app.home, "tracked.txt"), "before\n");
  await git("add", "tracked.txt");
  await git("commit", "-m", "fixture baseline");
  const original = await git("rev-parse", "HEAD");
  const cli = path.join(app.root, "synthetic-pipeline.cjs");
  await fs.writeFile(
    cli,
    `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
let prompt='';process.stdin.on('data',chunk=>prompt+=chunk);process.stdin.on('end',()=>{
 const match=prompt.match(/\\.pipeline\\/turns\\/[A-Za-z0-9-]+\\/verdict\\.json/);
 if(!match){process.stderr.write('Missing scoped verdict path');process.exit(2);}
 fs.writeFileSync('tracked.txt','after\\n');fs.writeFileSync('report.md','Evidence from the fixture.\\n');
 fs.mkdirSync(path.dirname(match[0]),{recursive:true});
 fs.writeFileSync(match[0],JSON.stringify({result:'pass',summary:'Fixture completed',artifacts:[{path:'report.md',label:'Report'}]}));
 console.log(JSON.stringify({type:'thread.started',thread_id:'fixture-native-thread'}));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:17,output_tokens:4}}));
});`,
    { mode: 0o700 },
  );
  const account = app.application.accounts.create({
    name: "Pipeline fixture",
    tool: "codex",
  });
  const command = app.application.accounts.command.bind(app.application.accounts);
  app.application.accounts.command = (id, _binaries, login, mode, options) =>
    command(id, { codex: cli }, login, mode, options);
  const profile = (
    await (
      await app.request("/api/pipeline-profiles", {
        method: "POST",
        body: {
          name: "Fixture stage",
          enabled: true,
          config: {
            accountId: account.id,
            cliTool: "codex",
            models: { available: [""], default: "" },
            prompts: { role: "", kickoff: "Perform the supplied task.", params: [] },
            permissions: { mode: "never" },
            run: { autonomous: true },
          },
        },
      })
    ).json()
  ).profile;
  const graph = {
    entry: "work",
    nodes: [
      { id: "work", kind: "profile", profileId: profile.id },
      { id: "verify", kind: "verify" },
      { id: "approve", kind: "gate" },
    ],
    edges: [
      { from: "work", to: "verify", condition: "default" },
      { from: "verify", to: "approve", condition: "default" },
    ],
  };
  const pipeline = (
    await (
      await app.request("/api/pipelines", {
        method: "POST",
        body: { name: "HTTP lifecycle", graph },
      })
    ).json()
  ).pipeline;
  const project = await (
    await app.request("/api/memory/projects", { method: "POST", body: { cwd: app.home } })
  ).json();
  assert.equal(
    (
      await app.request(`/api/pipeline-verification/${project.id}`, {
        method: "PUT",
        body: {
          steps: [
            {
              name: "Evidence exists",
              command: "test -f report.md",
              timeoutMs: 2000,
              blocking: true,
            },
          ],
        },
      })
    ).status,
    200,
  );
  const started = await app.request("/api/pipeline-runs", {
    method: "POST",
    body: {
      pipelineId: pipeline.id,
      cwd: app.home,
      task: "Update the fixture and report the result.",
    },
  });
  assert.equal(started.status, 201);
  const id = (await started.json()).run.id;
  let run = await waitFor(app, id, "awaiting-human");
  assert.equal(run.nodes[0].verdict.result, "pass");
  assert.equal(run.nodes[0].verifyResult.status, "pass");
  assert.equal(run.projectId, project.id);
  assert.notEqual(run.workingDir, app.home);
  assert.equal(await git("rev-parse", "HEAD"), original);
  assert.equal(await fs.readFile(path.join(app.home, "tracked.txt"), "utf8"), "before\n");
  const diff = await (
    await app.request(`/api/pipeline-runs/${id}/nodes/work/diff`)
  ).json();
  assert.match(diff.diff, /\+after/);
  const artifact = await (
    await app.request(`/api/pipeline-runs/${id}/nodes/work/artifact?path=report.md`)
  ).json();
  assert.match(artifact.content, /Evidence from the fixture/);
  assert.equal(
    (await app.request(`/api/pipelines/${pipeline.id}`, { method: "DELETE" })).status,
    409,
  );
  await app.restart();
  run = (await (await app.request(`/api/pipeline-runs/${id}`)).json()).run;
  assert.equal(run.status, "awaiting-human");
  assert.equal(run.executionLog.length, 1);
  const accepted = await app.request(`/api/pipeline-runs/${id}/gate`, {
    method: "POST",
    body: { action: "accept" },
  });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).run.status, "completed");
  assert.equal(
    await fs.readFile(path.join(run.workingDir, "report.md"), "utf8"),
    "Evidence from the fixture.\n",
  );
  assert.equal(
    (
      await app.request(`/api/pipeline-runs/${id}/gate`, {
        method: "POST",
        body: { action: "accept" },
      })
    ).status,
    409,
  );
});
