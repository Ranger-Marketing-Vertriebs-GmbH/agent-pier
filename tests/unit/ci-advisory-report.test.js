import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import {
  failedAdvisoryJobs,
  isAdvisoryJob,
  marker,
  pullRequestNumbers,
  readState,
  renderComment,
  report,
  requiredChecks,
} from "../../scripts/ci-advisory-report.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const workflowFile = (name) =>
  YAML.parse(fs.readFileSync(path.join(root, ".github/workflows", name), "utf8"));
const reporter = workflowFile("advisory-report.yml");
const bot = { login: "github-actions[bot]", type: "Bot" };

let jobId = 1000;
const job = (name, conclusion = "success") => ({
  name,
  conclusion,
  html_url: `https://github.com/o/r/actions/runs/7/job/${jobId++}`,
});
const verifyJobs = (overrides = {}) =>
  [
    "select tests",
    "backend (ubuntu-latest, 24)",
    "backend (macos-latest, 24)",
    "browser (chromium) shard 1/4",
    "browser (chromium)",
    "browser (webkit) shard 1/5",
    "browser (webkit)",
    "native filesystem matrix (ubuntu-latest)",
  ].map((name) => job(name, overrides[name]));
const run = (fields = {}) => ({
  id: 7,
  run_attempt: 1,
  name: "Verify",
  event: "pull_request",
  conclusion: "failure",
  head_sha: "a".repeat(40),
  head_branch: "feat/x",
  html_url: "https://github.com/o/r/actions/runs/7",
  run_started_at: "2026-10-17T10:00:00Z",
  pull_requests: [{ number: 12 }],
  head_repository: { owner: { login: "o" } },
  ...fields,
});

// An in-memory GitHub REST API with the few endpoints the reporter uses.
function fakeGitHub({ jobs = verifyJobs(), headSha = "a".repeat(40), pulls = [] } = {}) {
  const comments = [];
  const calls = [];
  let nextId = 100;
  const api = async (method, url, body) => {
    calls.push(`${method} ${url}`);
    const route = url.replace(/^\/repos\/o\/r/, "");
    if (method === "GET" && /^\/actions\/runs\/\d+\/attempts\/\d+\/jobs/.test(route))
      return { total_count: jobs.length, jobs };
    if (method === "GET" && /^\/pulls\/\d+$/.test(route))
      return { number: Number(route.split("/")[2]), head: { sha: headSha } };
    if (method === "GET" && route.startsWith("/pulls?")) return pulls;
    if (method === "GET" && /^\/issues\/\d+\/comments/.test(route))
      return comments.filter((comment) => comment.issue === Number(route.split("/")[2]));
    if (method === "POST" && /^\/issues\/\d+\/comments$/.test(route)) {
      const comment = {
        id: nextId++,
        issue: Number(route.split("/")[2]),
        user: bot,
        body: body.body,
      };
      comments.push(comment);
      return comment;
    }
    const id = Number(route.split("/").at(-1));
    const comment = comments.find((candidate) => candidate.id === id);
    if (method === "GET" && route.startsWith("/issues/comments/")) return comment;
    if (method === "PATCH" && route.startsWith("/issues/comments/")) {
      comment.body = body.body;
      return comment;
    }
    if (method === "DELETE" && route.startsWith("/issues/comments/")) {
      comments.splice(comments.indexOf(comment), 1);
      return null;
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { api, comments, calls };
}
const options = (github, workflowRun, extra = {}) => ({
  api: github.api,
  repository: "o/r",
  run: workflowRun,
  sleep: async () => {},
  ...extra,
});

test("only jobs outside the required checks and their inputs are advisory", () => {
  assert.deepEqual(requiredChecks, [
    "backend (ubuntu-latest, 24)",
    "browser (chromium)",
    "secrets",
  ]);
  for (const name of [
    "backend (macos-latest, 24)",
    "backend (ubuntu-latest, 22)",
    "browser (webkit)",
    "browser (webkit) shard 3/5",
    "native filesystem matrix (macos-latest)",
    "Fresh install (linux-x64)",
    "Native contracts (ubuntu-latest)",
    "Assistant runtime (queue)",
  ])
    assert.equal(isAdvisoryJob(name), true, name);
  for (const name of [
    "backend (ubuntu-latest, 24)",
    "browser (chromium)",
    "browser (chromium) shard 2/4",
    "select tests",
    "secrets",
  ])
    assert.equal(isAdvisoryJob(name), false, name);
});

test("failed advisory jobs include timeouts and cancellations, not skips", () => {
  const failed = failedAdvisoryJobs(
    verifyJobs({
      "backend (ubuntu-latest, 24)": "failure",
      "backend (macos-latest, 24)": "timed_out",
      "browser (webkit) shard 1/5": "failure",
      "browser (webkit)": "cancelled",
      "native filesystem matrix (ubuntu-latest)": "skipped",
    }),
  );
  assert.deepEqual(
    failed.map(({ name, conclusion }) => [name, conclusion]),
    [
      ["backend (macos-latest, 24)", "timed_out"],
      ["browser (webkit) shard 1/5", "failure"],
      ["browser (webkit)", "cancelled"],
    ],
  );
});

test("a merge-group run belongs to the pull request named in its queue ref", () => {
  assert.deepEqual(
    pullRequestNumbers(
      run({
        event: "merge_group",
        pull_requests: [],
        head_branch: `gh-readonly-queue/main/pr-345-${"b".repeat(40)}`,
      }),
    ),
    [345],
  );
  assert.deepEqual(pullRequestNumbers(run({ pull_requests: [{ number: 9 }] })), [9]);
  assert.deepEqual(
    pullRequestNumbers(
      run({ event: "merge_group", pull_requests: [], head_branch: "main" }),
    ),
    [],
  );
});

test("a red advisory job creates one comment naming the job, the run and the release", async () => {
  const github = fakeGitHub({
    jobs: verifyJobs({ "backend (macos-latest, 24)": "failure" }),
  });
  const result = await report(options(github, run()));
  assert.deepEqual(result.pullRequests, [12]);
  assert.equal(github.comments.length, 1);
  const { body } = github.comments[0];
  assert.ok(body.startsWith(marker));
  assert.match(body, /fix before the next release/);
  assert.match(
    body,
    /\[`backend \(macos-latest, 24\)`\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/7\/job\//,
  );
  assert.match(
    body,
    /\*\*Verify\*\* \(pull request\) · `aaaaaaa` · \[run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/7\)/,
  );
  assert.match(result.summary, /backend \(macos-latest, 24\)/);
  assert.match(result.summary, /#12/);
});

test("a green run never opens a comment", async () => {
  const github = fakeGitHub();
  const result = await report(options(github, run({ conclusion: "success" })));
  assert.equal(github.comments.length, 0);
  assert.match(result.summary, /All advisory jobs passed/);
});

test("later runs update the same comment and report green again", async () => {
  const github = fakeGitHub({
    jobs: verifyJobs({ "browser (webkit)": "failure" }),
  });
  const queue = run({
    event: "merge_group",
    pull_requests: [],
    head_branch: `gh-readonly-queue/main/pr-12-${"a".repeat(40)}`,
  });
  await report(options(github, queue));
  const runtime = fakeGitHub({ jobs: [job("Fresh install (linux-x64)", "failure")] });
  runtime.comments.push(...github.comments);
  await report(
    options(
      runtime,
      run({ id: 8, name: "Assistant runtime", run_started_at: "2026-10-17T10:01:00Z" }),
    ),
  );
  assert.equal(runtime.comments.length, 1);
  assert.match(runtime.comments[0].body, /`browser \(webkit\)`/);
  assert.match(runtime.comments[0].body, /`Fresh install \(linux-x64\)`/);

  const greenQueue = fakeGitHub();
  greenQueue.comments.push(...runtime.comments);
  await report(
    options(greenQueue, { ...queue, id: 9, run_started_at: "2026-10-17T11:00:00Z" }),
  );
  assert.doesNotMatch(greenQueue.comments[0].body, /`browser \(webkit\)`/);
  assert.match(greenQueue.comments[0].body, /fix before the next release/);

  const greenRuntime = fakeGitHub({ jobs: [job("Fresh install (linux-x64)")] });
  greenRuntime.comments.push(...greenQueue.comments);
  await report(
    options(
      greenRuntime,
      run({ id: 10, name: "Assistant runtime", run_started_at: "2026-10-17T11:01:00Z" }),
    ),
  );
  assert.equal(greenRuntime.comments.length, 1);
  const { body } = greenRuntime.comments[0];
  assert.match(body, /All advisory checks are green again/);
  assert.doesNotMatch(body, /fix before the next release/);
  assert.deepEqual(Object.keys(readState(body)).sort(), [
    "Assistant runtime/pull_request",
    "Verify/merge_group",
  ]);
});

test("an older or superseded run never overwrites a newer result", async () => {
  const github = fakeGitHub({ jobs: verifyJobs({ "browser (webkit)": "failure" }) });
  await report(options(github, run({ run_started_at: "2026-10-17T12:00:00Z" })));
  const before = github.comments[0].body;
  const late = fakeGitHub();
  late.comments.push(...github.comments);
  const stale = await report(
    options(late, run({ id: 3, run_started_at: "2026-10-17T09:00:00Z" })),
  );
  assert.equal(stale.skipped, undefined);
  assert.equal(late.comments[0].body, before);
  const outdated = fakeGitHub({ headSha: "c".repeat(40) });
  outdated.comments.push(...github.comments);
  const moved = await report(
    options(outdated, run({ run_started_at: "2026-10-17T13:00:00Z" })),
  );
  assert.deepEqual(moved.pullRequests, []);
  assert.equal(outdated.comments[0].body, before);
  const idle = fakeGitHub();
  const cancelled = await report(options(idle, run({ conclusion: "cancelled" })));
  assert.match(cancelled.skipped, /cancelled/);
  const push = await report(options(idle, run({ event: "push" })));
  assert.match(push.skipped, /push/);
  assert.deepEqual(idle.calls, []);
});

test("only the bot's own comment carries state; a forged marker is ignored", async () => {
  const github = fakeGitHub({ jobs: verifyJobs({ "browser (webkit)": "failure" }) });
  github.comments.push({
    id: 1,
    issue: 12,
    user: { login: "someone", type: "User" },
    body: `${marker}\nforged`,
  });
  await report(options(github, run()));
  assert.equal(github.comments.length, 2);
  assert.equal(github.comments[0].body, `${marker}\nforged`);
});

test("a concurrent writer is merged in, and duplicate comments collapse into one", async () => {
  const github = fakeGitHub({ jobs: verifyJobs({ "browser (webkit)": "failure" }) });
  const other = renderComment({
    "Assistant runtime/pull_request": {
      workflow: "Assistant runtime",
      event: "pull_request",
      sha: "a".repeat(40),
      runUrl: "https://github.com/o/r/actions/runs/5",
      startedAt: "2026-10-17T10:00:00Z",
      failed: [
        {
          name: "Native contracts (ubuntu-latest)",
          conclusion: "failure",
          url: "https://github.com/o/r/actions/runs/5/job/1",
        },
      ],
    },
  });
  let raced = false;
  const result = await report(
    options(github, run(), {
      // Another reporter creates its own comment between our read and verify.
      sleep: async () => {
        if (raced) return;
        raced = true;
        github.comments.push({ id: 50, issue: 12, user: bot, body: other });
      },
    }),
  );
  assert.deepEqual(result.pullRequests, [12]);
  assert.equal(github.comments.length, 1);
  const state = readState(github.comments[0].body);
  assert.deepEqual(Object.keys(state).sort(), [
    "Assistant runtime/pull_request",
    "Verify/pull_request",
  ]);
});

test("job names and links cannot inject markup into the comment", () => {
  const body = renderComment({
    "Verify/pull_request": {
      workflow: "Verify",
      event: "pull_request",
      sha: "a".repeat(40),
      runUrl: "javascript:alert(1)",
      startedAt: "2026-10-17T10:00:00Z",
      failed: [
        {
          name: "x`](https://evil)<img>\n@team",
          conclusion: "failure",
          url: "https://evil.example/x",
        },
      ],
    },
  });
  assert.doesNotMatch(body, /javascript:|evil\.example|<img>|@team/);
  assert.equal(body.split("\n").filter((line) => line.includes("x")).length >= 1, true);
  assert.deepEqual(readState("no state"), {});
  assert.deepEqual(readState(`${marker}\n<!-- state:!!! -->`), {});
});

test("a fork pull request is found by its head branch and sha", async () => {
  const github = fakeGitHub({
    jobs: verifyJobs({ "browser (webkit)": "failure" }),
    pulls: [
      { number: 30, head: { sha: "f".repeat(40) } },
      { number: 31, head: { sha: "a".repeat(40) } },
    ],
  });
  const result = await report(
    options(
      github,
      run({ pull_requests: [], head_repository: { owner: { login: "fork" } } }),
    ),
  );
  assert.deepEqual(result.pullRequests, [31]);
  assert.ok(
    github.calls.includes(
      "GET /repos/o/r/pulls?head=fork%3Afeat%2Fx&state=open&per_page=100",
    ),
  );
});

test("the reporter workflow reads results only and never runs pull request code", () => {
  const watched = [
    "verify.yml",
    "assistant-runtime.yml",
    "assistant-runtime-queue.yml",
  ].map((name) => workflowFile(name).name);
  assert.deepEqual(Object.keys(reporter.on), ["workflow_run"]);
  assert.deepEqual(reporter.on.workflow_run.workflows, watched);
  assert.deepEqual(reporter.on.workflow_run.types, ["completed"]);
  assert.deepEqual(reporter.permissions, {});
  const jobs = Object.values(reporter.jobs);
  assert.equal(jobs.length, 1);
  const [only] = jobs;
  assert.deepEqual(only.permissions, {
    actions: "read",
    contents: "read",
    "pull-requests": "write",
  });
  assert.match(only.if, /workflow_run\.event == 'pull_request'/);
  assert.match(only.if, /workflow_run\.event == 'merge_group'/);
  const text = fs.readFileSync(
    path.join(root, ".github/workflows/advisory-report.yml"),
    "utf8",
  );
  // The default-branch checkout only: no ref, repository or artifact from the run.
  assert.doesNotMatch(text, /head_sha|head_branch|download-artifact|secrets\./);
  const checkout = only.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkout.with, { "persist-credentials": false });
  const script = only.steps.find((step) => step.run?.includes("ci-advisory-report.mjs"));
  assert.equal(script.env.GITHUB_TOKEN, "${{ github.token }}");
});

test("the required checks match the documented branch rules", () => {
  const doc = fs.readFileSync(path.join(root, "docs/testing.md"), "utf8");
  for (const name of requiredChecks.filter((check) => check !== "secrets"))
    assert.ok(doc.includes(`\`${name}\``), name);
});
