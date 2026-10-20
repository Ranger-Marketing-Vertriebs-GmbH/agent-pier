import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applicationFixture } from "../helpers/application.js";
const exec = promisify(execFile);

const SPEC = `# Spec

## Context
- work.txt

## Requirements
- Write the work file.

## Acceptance criteria
1. work.txt exists. Verify: test -f work.txt

## Out of scope
- Everything else

## Assumptions
- The repository stays small.
`;

// A synthetic Codex CLI that plays every role of the seeded factory, recognised by the
// seed's role instructions. The spec writer declares spec.md in its report directory,
// the implementer changes work.txt (and keeps the thread it is asked to resume), the
// reviewers and the approver pass without touching the worktree. With a "fail-security"
// marker the security reviewer fails its first review.
const syntheticCli = (root, spec) => `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=${JSON.stringify(root)};
const args=process.argv.slice(2);if(args.includes('--version')){console.log('0.130.0');process.exit(0)}
const roles=[['spec','Write the contract for the task'],['implement','Implement the task using'],['security','Review the task changes for authentication'],['code','Review the current branch and task'],['ux',"Review the change from the user's side"],['ui','Review how the change looks'],['approve','Decide whether the run can go to the owner']];
let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{
 const at=args.indexOf('resume'),resume=at>=0?args[at+1]:null;
 const role=(roles.find(([,text])=>prompt.includes('Role instructions:\\n'+text))||['unknown'])[0];
 fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({role,resume,stage:process.env.AGENTPIER_STAGE_ID,port:process.env.AGENTPIER_PORT})+'\\n');
 const verdictPath=prompt.match(/\\.pipeline\\/turns\\/[A-Za-z0-9-]+\\/verdict\\.json/)[0];
 const reportDir=prompt.match(/report directory is (\\.pipeline\\/reports\\/[A-Za-z0-9\\/-]+?)\\/\\./)[1];
 const thread=resume||crypto.randomUUID();
 console.log(JSON.stringify({type:'thread.started',thread_id:thread}));
 const met=[{criterion:'AC1',status:'met',evidence:'test -f work.txt'}];
 let verdict={result:'pass',summary:role+' passes'};
 if(role==='spec'){
  fs.mkdirSync(reportDir,{recursive:true});fs.writeFileSync(reportDir+'/spec.md',${JSON.stringify(spec)});
  verdict={result:'pass',summary:'Spec written',artifacts:[{path:reportDir+'/spec.md',role:'spec'}]};
 } else if(role==='implement'){
  fs.writeFileSync('work.txt',(resume?'repaired':'built')+'\\n');
  const ids=[...new Set([...prompt.matchAll(/"id":"(R\\d+-\\d+)"/g)].map(m=>m[1]))];
  verdict={result:'pass',summary:resume?'Repaired in the same thread':'Built',criteria:met,...(ids.length?{responses:ids.map(finding=>({finding,status:'fixed'}))}:{})};
 } else if(role==='security'&&fs.existsSync(path.join(root,'fail-security'))&&!fs.existsSync(path.join(root,'security-failed'))){
  fs.writeFileSync(path.join(root,'security-failed'),'1');
  verdict={result:'fail',summary:'Input is not escaped',findings:[{severity:'high',title:'Unescaped input',criterion:'AC1'}]};
 } else if(role==='approve') verdict={result:'pass',summary:'Checked AC1 myself',criteria:met};
 fs.mkdirSync(path.dirname(verdictPath),{recursive:true});
 fs.writeFileSync(verdictPath,JSON.stringify(verdict));
 console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:resume?40:400,output_tokens:5}}));
});`;

// A fake GitHub CLI: no open pull request yet, then a new one.
const fakeGh = (root) => `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root, "gh-calls.jsonl"))},JSON.stringify(args)+'\\n');
if(args[1]==='list')console.log('[]');else console.log('https://github.example/org/repo/pull/7');
`;

async function factoryApp(t) {
  const app = await applicationFixture(t);
  const env = { PATH: process.env.PATH, HOME: app.home, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (cwd, ...args) => exec("git", args, { cwd, env });
  await git(app.project, "init", "-b", "main");
  await git(app.project, "config", "user.name", "Pipeline fixture");
  await git(app.project, "config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(app.project, "tracked.txt"), "before\n");
  await git(app.project, "add", "tracked.txt");
  await git(app.project, "commit", "-m", "fixture baseline");
  // A GitHub origin whose pushes land in a local bare repository.
  const remote = path.join(app.root, "remote.git");
  await exec("git", ["init", "--bare", "-b", "main", remote], { env });
  await git(
    app.project,
    "remote",
    "add",
    "origin",
    "https://github.example/org/repo.git",
  );
  await git(app.project, "config", "remote.origin.pushurl", remote);
  const cli = path.join(app.root, "synthetic-codex.cjs");
  await fs.writeFile(cli, syntheticCli(app.root, SPEC), { mode: 0o700 });
  const gh = path.join(app.root, "fake-gh.cjs");
  await fs.writeFile(gh, fakeGh(app.root), { mode: 0o700 });
  app.application.github.resolveGh = () => gh;
  const command = app.application.accounts.command.bind(app.application.accounts);
  app.application.accounts.command = (id, _binaries, login, mode, options) =>
    command(id, { codex: cli }, login, mode, options);
  const account = app.application.accounts.create({ name: "Fixture", tool: "codex" });
  // The seeded pipeline stays as it is; only its profiles move to the fixture account.
  const pipeline = (await (await app.request("/api/pipelines")).json()).pipelines.find(
    (p) => p.id === "seed-software-factory",
  );
  assert.ok(pipeline, "the factory is seeded");
  const ids = pipeline.graph.nodes.flatMap((n) =>
    n.kind === "parallel" ? n.members.map((m) => m.profileId) : n.profileId || [],
  );
  assert.equal(ids.length, 7);
  for (const id of ids) {
    const { profile } = await (await app.request(`/api/pipeline-profiles/${id}`)).json();
    const saved = await app.request(`/api/pipeline-profiles/${id}`, {
      method: "PATCH",
      body: {
        ...profile,
        expectedRevision: profile.revision,
        config: {
          ...profile.config,
          accountId: account.id,
          cliTool: "codex",
          permissions: { mode: "never" },
        },
      },
    });
    assert.equal(saved.status, 200);
  }
  const start = async () => {
    const started = await app.request("/api/pipeline-runs", {
      method: "POST",
      body: { pipelineId: pipeline.id, cwd: app.project, task: "Write the work file." },
    });
    assert.equal(started.status, 201);
    return (await started.json()).run.id;
  };
  const lines = async (name) =>
    (await fs.readFile(path.join(app.root, name), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return {
    app,
    start,
    calls: () => lines("calls.jsonl"),
    ghCalls: () => lines("gh-calls.jsonl"),
    remoteFile: (branch, file) => git(remote, "show", `refs/heads/${branch}:${file}`),
    marker: (name) => fs.writeFile(path.join(app.root, name), "1"),
  };
}

async function waitFor(app, id, done) {
  const deadline = Date.now() + 90000;
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
  assert.fail(
    `Pipeline did not settle: ${run?.status} ${JSON.stringify(
      run?.nodes?.map((n) => [n.id, n.status, n.failReason]),
    )}`,
  );
}
const completed = (run) => run.status === "completed";
const MEMBERS = ["security", "code", "ux", "ui"];

test("the seeded software factory runs from spec to a published pull request", async (t) => {
  const { app, start, calls, ghCalls, remoteFile } = await factoryApp(t);
  const id = await start();
  const run = await waitFor(app, id, completed);
  assert.equal(run.pullRequestUrl, "https://github.example/org/repo/pull/7");
  assert.equal(run.spec.frozen, true);
  assert.deepEqual(
    run.spec.criteria.map((c) => c.id),
    ["AC1"],
  );
  // Every stage ran its own seeded role; the four reviewers each in a turn of their own
  // with their own port block, and their read-only join let the run continue.
  const turns = await calls();
  assert.deepEqual(
    turns.map((c) => c.role).filter((r) => !MEMBERS.includes(r)),
    ["spec", "implement", "approve"],
  );
  const members = turns.filter((c) => MEMBERS.includes(c.role));
  assert.deepEqual(members.map((c) => c.role).sort(), [...MEMBERS].sort());
  assert.deepEqual(members.map((c) => c.stage).sort(), [...MEMBERS].sort());
  assert.equal(new Set(members.map((c) => c.port)).size, 4);
  const review = run.nodes.find((n) => n.id === "review");
  assert.equal(review.status, "passed");
  assert.equal(
    run.nodes.find((n) => n.id === "implement").verifyResult.status,
    "not-configured",
  );
  // The checked commit reached the remote branch, and gh opened the pull request.
  assert.equal((await remoteFile(run.branch, "work.txt")).stdout, "built\n");
  await assert.rejects(remoteFile(run.branch, ".pipeline"));
  const gh = await ghCalls();
  assert.deepEqual(
    gh.map((args) => args.slice(0, 2)),
    [
      ["pr", "list"],
      ["pr", "create"],
    ],
  );
  assert.ok(gh[1].includes(run.branch));
});

test("a failing review resumes the implementer's thread and the repaired run is published", async (t) => {
  const { app, start, calls, remoteFile, marker } = await factoryApp(t);
  await marker("fail-security");
  const id = await start();
  const run = await waitFor(app, id, completed);
  const implementer = (await calls()).filter((c) => c.role === "implement");
  assert.equal(implementer.length, 2);
  assert.equal(implementer[0].resume, null);
  assert.match(implementer[1].resume, /^[0-9a-f-]{36}$/);
  const repair = run.executionLog.find((a) => a.kind === "resumed-repair");
  assert.deepEqual(repair.repair, {
    edge: "review->implement",
    round: 1,
    session: "resumed",
  });
  assert.deepEqual(run.loopRounds[0].responses, [{ finding: "R1-1", status: "fixed" }]);
  // Every reviewer ran twice: the whole group reviews the repair again.
  for (const role of MEMBERS)
    assert.equal((await calls()).filter((c) => c.role === role).length, 2, role);
  assert.equal((await remoteFile(run.branch, "work.txt")).stdout, "repaired\n");
  assert.equal(run.pullRequestUrl, "https://github.example/org/repo/pull/7");
});
