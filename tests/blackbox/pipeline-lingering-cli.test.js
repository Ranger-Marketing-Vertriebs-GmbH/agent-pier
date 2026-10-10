import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applicationFixture } from "../helpers/application.js";
const exec = promisify(execFile);

// Models `opencode run`: it finishes its final step, writes the verdict and then
// keeps the process alive without further output.
const lingeringCli = (pidFile, complete = true) => `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);if(args.includes('--version')){console.log('1.0.0');process.exit(0)}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
 const match=prompt.match(/\\.pipeline\\/turns\\/[A-Za-z0-9-]+\\/verdict\\.json/);
 const sessionID='ses_lingering';
 console.log(JSON.stringify({type:'step_start',sessionID}));
 fs.writeFileSync('hello.txt','hello\\n');
 fs.mkdirSync(path.dirname(match[0]),{recursive:true});
 fs.writeFileSync(match[0],JSON.stringify({result:'pass',summary:'Created hello.txt'}));
 if(${complete})console.log(JSON.stringify({type:'step_finish',sessionID,part:{reason:'stop',tokens:{input:5,output:2}}}));
 fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
 setInterval(()=>{},1000);
});
process.stdin.resume();`;

async function waitFor(app, id, done) {
  const deadline = Date.now() + 20000;
  let run;
  do {
    const response = await app.request(`/api/pipeline-runs/${id}`);
    run = (await response.json()).run;
    if (done(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`Pipeline did not settle: ${JSON.stringify(run)}`);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function lingeringRun(t, pipelines, complete) {
  const app = await applicationFixture(t, {
    pipelines: { pollIntervalMs: 100, ...pipelines },
  });
  const env = { PATH: process.env.PATH, HOME: app.home, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => exec("git", args, { cwd: app.project, env });
  await git("init", "-b", "main");
  await git("config", "user.name", "Pipeline fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(app.project, "README.md"), "fixture\n");
  await git("add", "README.md");
  await git("commit", "-m", "fixture baseline");
  const cli = path.join(app.root, "lingering-opencode.cjs"),
    pidFile = path.join(app.root, "lingering.pid");
  await fs.writeFile(cli, lingeringCli(pidFile, complete), { mode: 0o700 });
  const account = app.application.accounts.create({
    name: "Lingering",
    tool: "opencode",
  });
  const command = app.application.accounts.command.bind(app.application.accounts);
  app.application.accounts.command = (id, _binaries, login, mode, options) =>
    command(id, { opencode: cli }, login, mode, options);
  const profile = app.application.pipelineDefinitions.saveProfile({
    name: "Lingering stage",
    enabled: true,
    config: {
      accountId: account.id,
      cliTool: "opencode",
      models: { available: [""], default: "" },
      prompts: { role: "", kickoff: "Perform the supplied task.", params: [] },
      permissions: { mode: "auto" },
      run: { autonomous: true },
    },
  });
  const pipeline = app.application.pipelineDefinitions.savePipeline({
    name: "Lingering",
    graph: {
      entry: "work",
      nodes: [{ id: "work", kind: "profile", profileId: profile.id }],
      edges: [],
    },
  });
  const started = await app.request("/api/pipeline-runs", {
    method: "POST",
    body: { pipelineId: pipeline.id, cwd: app.project, task: "Create hello.txt" },
  });
  assert.equal(started.status, 201);
  const id = (await started.json()).run.id;
  return { app, id, pidFile };
}

test("a native CLI that never exits after its completed turn is stopped and the stage concludes", async (t) => {
  const { app, id, pidFile } = await lingeringRun(t, { completionGraceMs: 300 }, true);
  const run = await waitFor(app, id, (r) => r.status !== "running");
  assert.equal(
    run.status,
    "completed",
    JSON.stringify({ node: run.nodes[0], log: run.executionLog }),
  );
  assert.equal(run.nodes[0].status, "passed");
  assert.equal(run.nodes[0].verdict.summary, "Created hello.txt");
  assert.ok(run.executionLog[0].settledAfterCompletion);
  assert.equal(run.executionLog[0].quiesced, true);
  const pid = Number(await fs.readFile(pidFile, "utf8"));
  assert.equal(alive(pid), false);
});

test("a timed-out turn is stopped with its exit status kept, so it can be overridden", async (t) => {
  const { app, id, pidFile } = await lingeringRun(t, { turnTimeoutMs: 1500 }, false);
  const parked = await waitFor(app, id, (r) => r.status !== "running");
  assert.equal(parked.nodes[0].failReason, "turn-timeout");
  assert.ok(parked.actions.includes("override"));
  assert.equal(alive(Number(await fs.readFile(pidFile, "utf8"))), false);
  const response = await app.request(`/api/pipeline-runs/${id}/gate`, {
    method: "POST",
    body: { action: "override" },
  });
  assert.equal(response.status, 200, await response.clone().text());
  const run = (await response.json()).run;
  assert.equal(run.status, "completed");
  assert.equal(run.nodes[0].overrides[0].failReason, "turn-timeout");
});
