import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applicationFixture } from "../helpers/application.js";
const exec = promisify(execFile);

// A synthetic Codex CLI. The implementer writes a file; a reviewer (MEMBER-ROLE:<name>)
// records its pid and port and passes, or keeps running while a "hold" marker exists.
const syntheticCli = (root) => `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=${JSON.stringify(root)};
const args=process.argv.slice(2);if(args.includes('--version')){console.log('0.130.0');process.exit(0)}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
 const member=(prompt.match(/MEMBER-ROLE:([a-z]+)/)||[])[1]||null;
 fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({member,pid:process.pid,port:process.env.AGENTPIER_PORT,stage:process.env.AGENTPIER_STAGE_ID})+'\\n');
 const finish=()=>{
  console.log(JSON.stringify({type:'thread.started',thread_id:crypto.randomUUID()}));
  const verdictPath=prompt.match(/\\.pipeline\\/turns\\/[A-Za-z0-9-]+\\/verdict\\.json/)[0];
  if(!member)fs.writeFileSync('work.txt','built\\n');
  fs.mkdirSync(path.dirname(verdictPath),{recursive:true});
  fs.writeFileSync(verdictPath,JSON.stringify({result:'pass',summary:member?member+' approves':'Built'}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:1}}));
 };
 if(member&&fs.existsSync(path.join(root,'hold')))setInterval(()=>{},1000);
 else finish();
});`;

async function groupApp(t) {
  const app = await applicationFixture(t);
  const env = { PATH: process.env.PATH, HOME: app.home, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => exec("git", args, { cwd: app.project, env });
  await git("init", "-b", "main");
  await git("config", "user.name", "Pipeline fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(app.project, "tracked.txt"), "before\n");
  await git("add", "tracked.txt");
  await git("commit", "-m", "fixture baseline");
  const cli = path.join(app.root, "synthetic-codex.cjs");
  await fs.writeFile(cli, syntheticCli(app.root), { mode: 0o700 });
  const command = app.application.accounts.command.bind(app.application.accounts);
  app.application.accounts.command = (id, _binaries, login, mode, options) =>
    command(id, { codex: cli }, login, mode, options);
  const account = app.application.accounts.create({ name: "Fixture", tool: "codex" });
  const profile = async (name, kickoff) =>
    (
      await (
        await app.request("/api/pipeline-profiles", {
          method: "POST",
          body: {
            name,
            enabled: true,
            config: {
              accountId: account.id,
              cliTool: "codex",
              models: { available: [""], default: "" },
              prompts: { role: "", kickoff, params: [] },
              permissions: { mode: "never" },
              run: { autonomous: true },
            },
          },
        })
      ).json()
    ).profile;
  const implementer = await profile("Implementer", "Do the task.");
  const security = await profile("Security", "MEMBER-ROLE:security review.");
  const code = await profile("Code", "MEMBER-ROLE:code review.");
  const response = await app.request("/api/pipelines", {
    method: "POST",
    body: {
      name: "Parallel review",
      graph: {
        entry: "implement",
        nodes: [
          { id: "implement", kind: "profile", profileId: implementer.id },
          {
            id: "review",
            kind: "parallel",
            members: [
              { id: "security", profileId: security.id },
              { id: "code", profileId: code.id },
            ],
          },
        ],
        edges: [{ from: "implement", to: "review", condition: "default" }],
      },
    },
  });
  assert.equal(response.status, 201);
  const pipeline = (await response.json()).pipeline;
  const start = async () => {
    const started = await app.request("/api/pipeline-runs", {
      method: "POST",
      body: { pipelineId: pipeline.id, cwd: app.project, task: "Build the fixture." },
    });
    assert.equal(started.status, 201);
    return (await started.json()).run.id;
  };
  const calls = async () =>
    (await fs.readFile(path.join(app.root, "calls.jsonl"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    app,
    start,
    calls,
    hold: () => fs.writeFile(path.join(app.root, "hold"), "1"),
  };
}

async function waitFor(app, id, done) {
  const deadline = Date.now() + 45000;
  let run;
  do {
    const response = await app.request(`/api/pipeline-runs/${id}`);
    if (response.status === 200) {
      run = (await response.json()).run;
      if (done(run)) return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`Pipeline did not settle: ${JSON.stringify(run?.executionLog)}`);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("two synthetic reviewers run side by side with their own port blocks", async (t) => {
  const { app, start, calls } = await groupApp(t);
  const id = await start();
  const run = await waitFor(app, id, (r) => r.status === "completed");
  const members = (await calls()).filter((call) => call.member);
  assert.deepEqual(members.map((call) => call.member).sort(), ["code", "security"]);
  assert.deepEqual(members.map((call) => call.stage).sort(), ["code", "security"]);
  assert.notEqual(members[0].port, members[1].port);
  const review = run.nodes.find((node) => node.id === "review");
  assert.equal(review.verdict.result, "pass");
  assert.equal(review.status, "passed");
});

test("cancelling a running group stops every member's process", async (t) => {
  const { app, start, calls, hold } = await groupApp(t);
  await hold();
  const id = await start();
  await waitFor(app, id, (r) => Object.keys(r.activeTurns || {}).length === 2);
  let members = [];
  const deadline = Date.now() + 15000;
  while (members.length < 2 && Date.now() < deadline) {
    members = (await calls()).filter((call) => call.member);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(members.length, 2);
  assert.ok(members.every((call) => alive(call.pid)));
  const cancelled = await app.request(`/api/pipeline-runs/${id}/cancel`, {
    method: "POST",
  });
  assert.equal(cancelled.status, 200);
  const stopped = Date.now() + 15000;
  while (members.some((call) => alive(call.pid)) && Date.now() < stopped)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(
    members.filter((call) => alive(call.pid)),
    [],
  );
  const run = await waitFor(app, id, (r) => r.status === "cancelled");
  assert.deepEqual(run.activeTurns, {});
});
