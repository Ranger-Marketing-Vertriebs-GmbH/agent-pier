import test from "node:test";
import assert from "node:assert/strict";
import { readState, renderComment, report } from "../../scripts/ci-advisory-report.mjs";
import {
  bot,
  entry,
  fakeGitHub,
  options,
  run,
  verifyJobs,
} from "../helpers/ci-advisory-github.js";

test("a red section of an older pull request revision no longer counts as red", async () => {
  const github = fakeGitHub({ headSha: "d".repeat(40) });
  github.comments.push({
    id: 1,
    issue: 12,
    user: bot,
    body: renderComment({
      "Assistant runtime/pull_request": entry({ workflow: "Assistant runtime" }),
    }),
  });
  // A later revision runs Verify only; Assistant runtime's paths are untouched.
  await report(
    options(
      github,
      run({
        head_sha: "d".repeat(40),
        conclusion: "success",
        run_started_at: "2026-10-17T11:00:00Z",
      }),
    ),
  );
  const { body } = github.comments[0];
  assert.match(body, /All advisory checks are green again/);
  assert.match(body, /older revision/);
  assert.match(body, /`ddddddd`/);
  assert.doesNotMatch(body, /fix before the next release/);
});

test("a green merge queue run clears the same workflow's red pull request section", () => {
  const state = {
    "Verify/pull_request": entry(),
    "Verify/merge_group": entry({
      event: "merge_group",
      pullRequest: 12,
      startedAt: "2026-10-17T11:00:00Z",
      failed: [],
    }),
  };
  const body = renderComment(state, { head: "a".repeat(40) });
  assert.match(body, /All advisory checks are green again/);
  assert.match(body, /merge queue passed/);
  const older = renderComment(
    {
      ...state,
      "Verify/merge_group": {
        ...state["Verify/merge_group"],
        startedAt: "2026-10-17T09:00:00Z",
      },
    },
    { head: "a".repeat(40) },
  );
  assert.match(older, /fix before the next release/);
  const otherWorkflow = renderComment(
    {
      "Assistant runtime/pull_request": entry({ workflow: "Assistant runtime" }),
      "Verify/merge_group": state["Verify/merge_group"],
    },
    { head: "a".repeat(40) },
  );
  assert.match(otherWorkflow, /fix before the next release/);
});

test("a merge-group section names the group of the pull request", async () => {
  const github = fakeGitHub({ jobs: verifyJobs({ "browser (webkit)": "failure" }) });
  await report(
    options(
      github,
      run({
        event: "merge_group",
        pull_requests: [],
        head_sha: "e".repeat(40),
        head_branch: `gh-readonly-queue/main/pr-12-${"e".repeat(40)}`,
      }),
    ),
  );
  assert.match(github.comments[0].body, /\*\*Verify\*\* \(merge group containing #12\)/);
  assert.match(github.comments[0].body, /fix before the next release/);
});

test("races that delete or replace the comment never fail the report", async () => {
  // The duplicate was already deleted by the other reporter: DELETE returns 404.
  const github = fakeGitHub({
    jobs: verifyJobs({ "browser (webkit)": "failure" }),
    failures: [{ method: "DELETE", status: 404 }],
  });
  github.comments.push(
    { id: 1, issue: 12, user: bot, body: renderComment({}) },
    { id: 2, issue: 12, user: bot, body: renderComment({}) },
  );
  const deleted = await report(options(github, run()));
  assert.deepEqual(deleted.pullRequests, [12]);
  assert.match(github.comments[0].body, /`browser \(webkit\)`/);

  // The comment vanished between read and PATCH: the next attempt recreates it.
  const failures = [];
  const gone = fakeGitHub({
    jobs: verifyJobs({ "browser (webkit)": "failure" }),
    failures,
  });
  gone.comments.push({ id: 1, issue: 12, user: bot, body: renderComment({}) });
  failures.push({
    method: "PATCH",
    status: 404,
    before: () => gone.comments.splice(0, 1),
  });
  const recreated = await report(options(gone, run()));
  assert.ok(gone.calls.some((call) => call.startsWith("POST ")));
  assert.equal(recreated.outcomes[12], "updated");
  assert.equal(gone.comments.length, 1);
  assert.match(gone.comments[0].body, /`browser \(webkit\)`/);

  // Another writer keeps overwriting: the last attempt is checked, not trusted.
  const busy = fakeGitHub({ jobs: verifyJobs({ "browser (webkit)": "failure" }) });
  const clobbered = await report(
    options(busy, run(), {
      sleep: async () => {
        busy.comments[0].body = renderComment({});
      },
    }),
  );
  assert.equal(clobbered.outcomes[12], "unverified");
  const other = fakeGitHub({ failures: [{ method: "PATCH", status: 500 }] });
  other.comments.push({
    id: 1,
    issue: 12,
    user: bot,
    body: renderComment({ "Verify/pull_request": entry() }),
  });
  await assert.rejects(
    report(
      options(
        other,
        run({ conclusion: "success", run_started_at: "2026-10-17T11:00:00Z" }),
      ),
    ),
    /HTTP 500/,
  );
});

test("huge failures stay well below GitHub's comment limit", () => {
  const failed = Array.from({ length: 1000 }, (_, index) => ({
    name: `${"n".repeat(300)}${index}`,
    conclusion: "failure",
    url: `https://github.com/o/r/actions/runs/5/job/${10_000_000_000 + index}`,
  }));
  const state = {};
  for (const workflow of ["Verify", "Assistant runtime", "Assistant runtime (queue)"])
    for (const event of ["pull_request", "merge_group"])
      state[`${workflow}/${event}`] = entry({ workflow, event, failed });
  const body = renderComment(state, { head: "a".repeat(40) });
  assert.ok(body.length < 60_000, String(body.length));
  assert.match(body, /and \d+ more/);
  for (const section of Object.values(readState(body))) {
    assert.ok(section.failed.length <= 30);
    assert.equal(section.failed.length + section.more, 1000);
    for (const job of section.failed) assert.ok(job.name.length <= 120);
  }
  const one = renderComment({ "Verify/pull_request": entry({ failed }) });
  assert.match(one, /and 970 more/);
});

test("invisible format characters are stripped from names", () => {
  const body = renderComment({
    "Verify/pull_request": entry({
      failed: [{ name: "web‮kit​⁦x", conclusion: "failure", url: null }],
    }),
  });
  assert.match(body, /`webkitx`/);
  assert.doesNotMatch(body, /\p{Cf}/u);
});
