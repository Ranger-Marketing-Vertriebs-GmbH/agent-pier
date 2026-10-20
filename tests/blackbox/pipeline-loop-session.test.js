import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applicationFixture } from "../helpers/application.js";
const exec = promisify(execFile);

// A synthetic Codex CLI. The implementer opens a new thread on a kickoff and keeps the
// thread it is asked to resume; it answers every finding id of the round. The reviewer
// fails its first review and passes the next. Marker files in the fixture root make a
// resume fail or wait for a release file.
const syntheticCli = (root) => `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=${JSON.stringify(root)};
const args=process.argv.slice(2);if(args.includes('--version')){console.log('0.130.0');process.exit(0)}
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
 const at=args.indexOf('resume'),resume=at>=0?args[at+1]:null;
 const reviewer=prompt.includes('REVIEWER-ROLE');
 fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({args,prompt,reviewer,resume})+'\\n');
 if(resume&&fs.existsSync(path.join(root,'fail-resume'))){
  console.log(JSON.stringify({type:'error',message:'No conversation found for '+resume}));process.exit(1);
 }
 const finish=()=>{
  const thread=resume||crypto.randomUUID();
  console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
  const verdictPath=prompt.match(/\\.pipeline\\/turns\\/[A-Za-z0-9-]+\\/verdict\\.json/)[0];
  let verdict;
  if(reviewer){
   const marker=path.join(root,'reviewed');
   const first=!fs.existsSync(marker);fs.writeFileSync(marker,'1');
   verdict=first?{result:'fail',summary:'Review found a gap',findings:[{severity:'high',title:'Input is not validated'}]}:{result:'pass',summary:'Approved'};
  } else {
   fs.writeFileSync('work.txt',(resume?'repaired':'built')+'\\n');
   const ids=[...new Set([...prompt.matchAll(/"id":"(R\\d+-\\d+)"/g)].map(m=>m[1]))];
   verdict={result:'pass',summary:resume?'Repaired in the same thread':'Built',...(ids.length?{responses:ids.map(finding=>({finding,status:'fixed'}))}:{})};
  }
  fs.mkdirSync(path.dirname(verdictPath),{recursive:true});
  fs.writeFileSync(verdictPath,JSON.stringify(verdict));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:resume?40:400,output_tokens:5}}));
 };
 if(resume&&fs.existsSync(path.join(root,'hold'))){
  const timer=setInterval(()=>{if(fs.existsSync(path.join(root,'release'))){clearInterval(timer);finish();}},50);
 } else finish();
});`;

async function pipelineApp(t) {
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
  // The account command is wired per application instance, so again after a restart.
  const wire = () => {
    const command = app.application.accounts.command.bind(app.application.accounts);
    app.application.accounts.command = (id, _binaries, login, mode, options) =>
      command(id, { codex: cli }, login, mode, options);
  };
  wire();
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
  const implementer = await profile("Implementer", "IMPLEMENTER-ROLE: do the task.");
  const reviewer = await profile("Reviewer", "REVIEWER-ROLE: review the change.");
  const response = await app.request("/api/pipelines", {
    method: "POST",
    body: {
      name: "Resumed repair",
      graph: {
        entry: "implement",
        nodes: [
          { id: "implement", kind: "profile", profileId: implementer.id },
          { id: "review", kind: "profile", profileId: reviewer.id },
        ],
        edges: [
          { from: "implement", to: "review", condition: "default" },
          {
            from: "review",
            to: "implement",
            condition: "fail",
            maxIterations: 2,
            continueSession: true,
          },
        ],
      },
    },
  });
  assert.equal(response.status, 201);
  const pipeline = (await response.json()).pipeline;
  assert.equal(pipeline.graph.edges[1].continueSession, true);
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
  const marker = (name) => fs.writeFile(path.join(app.root, name), "1");
  return { app, wire, start, calls, marker };
}

async function waitFor(app, id, done) {
  const deadline = Date.now() + 45000;
  let run;
  do {
    const response = await app.request(`/api/pipeline-runs/${id}`);
    if (response.status === 200) {
      run = (await response.json()).run;
      if (done(run)) return run;
      if (["failed", "cancelled", "awaiting-human"].includes(run.status)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(`Pipeline did not settle: ${JSON.stringify(run?.executionLog)}`);
}
const completed = (run) => run.status === "completed";

test("a review loop back resumes the implementer's native thread", async (t) => {
  const { app, start, calls } = await pipelineApp(t);
  const id = await start();
  const run = await waitFor(app, id, completed);
  const log = run.executionLog;
  assert.deepEqual(
    log.map((entry) => [entry.nodeId, entry.kind]),
    [
      ["implement", "kickoff"],
      ["review", "kickoff"],
      ["implement", "resumed-repair"],
      ["review", "kickoff"],
    ],
  );
  const invocations = (await calls()).filter((call) => !call.reviewer);
  assert.equal(invocations.length, 2);
  assert.equal(invocations[0].resume, null);
  // `codex exec ... resume <thread> -` with the first turn's thread.
  const thread = invocations[1].resume;
  assert.match(thread, /^[0-9a-f-]{36}$/);
  assert.equal(run.nodes[0].nativeId, thread);
  assert.deepEqual(invocations[1].args.slice(-3), ["resume", thread, "-"]);
  assert.doesNotMatch(invocations[1].prompt, /IMPLEMENTER-ROLE/);
  assert.match(invocations[1].prompt, /Repair round 1 of 2, sent back by review/);
  assert.match(invocations[1].prompt, /Input is not validated/);
  assert.deepEqual(log[2].repair, {
    edge: "review->implement",
    round: 1,
    session: "resumed",
  });
  assert.deepEqual(log[2].usage, { inputTokens: 40, outputTokens: 5 });
  assert.deepEqual(log[0].usage, { inputTokens: 400, outputTokens: 5 });
  assert.equal(run.loopRounds[0].repairAttemptId, log[2].attemptId);
  assert.deepEqual(run.loopRounds[0].responses, [{ finding: "R1-1", status: "fixed" }]);
});

test("a resume the CLI rejects is repeated as a fresh kickoff of the round", async (t) => {
  const { app, start, calls, marker } = await pipelineApp(t);
  await marker("fail-resume");
  const id = await start();
  const run = await waitFor(app, id, completed);
  const log = run.executionLog;
  assert.deepEqual(
    log.map((entry) => [entry.nodeId, entry.kind, entry.failReason]),
    [
      ["implement", "kickoff", undefined],
      ["review", "kickoff", undefined],
      ["implement", "resumed-repair", "resume-failed"],
      ["implement", "kickoff", undefined],
      ["review", "kickoff", undefined],
    ],
  );
  assert.deepEqual(log[3].repair, {
    edge: "review->implement",
    round: 1,
    session: "fresh",
    fallback: "resume-failed",
  });
  const invocations = (await calls()).filter((call) => !call.reviewer);
  assert.equal(invocations.length, 3);
  assert.ok(invocations[1].resume);
  assert.equal(invocations[2].resume, null);
  assert.match(invocations[2].prompt, /IMPLEMENTER-ROLE/);
  assert.match(invocations[2].prompt, /Repair round 1 of 2/);
});

test("a restart during a resumed turn settles it in the same thread", async (t) => {
  const { app, wire, start, calls, marker } = await pipelineApp(t);
  await marker("hold");
  const id = await start();
  await waitFor(
    app,
    id,
    (run) => Object.values(run.activeTurns || {})[0]?.kind === "resumed-repair",
  );
  const deadline = Date.now() + 10000;
  while (!(await calls()).some((call) => call.resume) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  await app.restart();
  wire();
  await marker("release");
  const run = await waitFor(app, id, completed);
  assert.deepEqual(
    run.executionLog.map((entry) => entry.kind),
    ["kickoff", "kickoff", "resumed-repair", "kickoff"],
  );
  assert.equal(run.executionLog[2].verdict.summary, "Repaired in the same thread");
  assert.equal((await calls()).filter((call) => call.resume).length, 1);
});
