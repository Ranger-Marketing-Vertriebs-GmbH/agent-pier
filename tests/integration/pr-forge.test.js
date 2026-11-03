import test from "node:test";
import assert from "node:assert/strict";

import {
  defaultBranch,
  disableAutoMerge,
  dequeue,
  enableAutoMerge,
  enqueue,
  findPullRequest,
  graphqlUrl,
  mergePullRequest,
  pullRequestByUrl,
  readPullRequest,
} from "../../server/features/tickets/pr-forge.js";
import { fakeGithubPulls, githubPull } from "../helpers/ticket-fakes.js";

const TOKEN = "ghp-secret-token";

function accessFor(fake, apiBase = "https://api.github.com") {
  return {
    host: "https://github.com",
    apiBase,
    owner: "acme",
    repo: "app",
    token: TOKEN,
    fetchImpl: fake.fetchImpl,
  };
}

const SINCE = "2026-11-03T09:00:00Z";

test("graphqlUrl", () => {
  assert.equal(graphqlUrl("https://api.github.com"), "https://api.github.com/graphql");
  assert.equal(
    graphqlUrl("https://ghe.example/api/v3"),
    "https://ghe.example/api/graphql",
  );
  assert.equal(
    graphqlUrl("https://api.acme.ghe.com"),
    "https://api.acme.ghe.com/graphql",
  );
});

const at = (minutes) => new Date(Date.parse(SINCE) + minutes * 60_000).toISOString();

test("findPullRequest looks the exact head branch up by head query", async (t) => {
  const fake = await fakeGithubPulls(t, {
    pulls: [
      githubPull(5, { headRef: "ticket/12-fix", createdAt: at(60) }),
      githubPull(6, { headRef: "other/12", createdAt: at(120) }),
    ],
  });
  const access = accessFor(fake);
  const pr = await findPullRequest(access, {
    key: "acme/app#12",
    branch: "ticket/12-fix",
    since: SINCE,
  });
  assert.deepEqual(pr, {
    number: 5,
    url: "https://github.com/acme/app/pull/5",
    headRef: "ticket/12-fix",
  });
  assert.equal(fake.calls.length, 1);
  const query = new URL(fake.calls[0].path, "http://x").searchParams;
  assert.equal(query.get("head"), "acme:ticket/12-fix");
  assert.equal(query.get("state"), "all");
  assert.equal(query.get("sort"), "created");
  assert.equal(query.get("direction"), "desc");
  assert.equal(query.get("per_page"), "50");
  assert.equal(fake.calls[0].authorization, `Bearer ${TOKEN}`);
  // Without a known branch (pipeline run) the newest key match wins.
  const byKey = await findPullRequest(access, { key: "acme/app#12", since: SINCE });
  assert.equal(byKey.number, 6);
  assert.equal(new URL(fake.calls[1].path, "http://x").searchParams.get("head"), null);
});

test("a known branch never falls back to the key search", async (t) => {
  const fake = await fakeGithubPulls(t, {
    pulls: [githubPull(6, { headRef: "feature/12-x", createdAt: at(60) })],
  });
  const access = accessFor(fake);
  const pr = await findPullRequest(access, {
    key: "acme/app#12",
    branch: "ticket/12-fix",
    since: SINCE,
  });
  assert.equal(pr, null);
  assert.equal(fake.calls.length, 1);
  // The exact head is found even beyond the latest 50 pull requests.
  for (let n = 100; n < 160; n += 1)
    fake.pulls.push(githubPull(n, { headRef: `other/${n}`, createdAt: at(200) }));
  fake.pulls.push(githubPull(7, { headRef: "ticket/12-fix", createdAt: at(30) }));
  const found = await findPullRequest(access, {
    key: "acme/app#12",
    branch: "ticket/12-fix",
    since: SINCE,
  });
  assert.equal(found.number, 7);
});

test("findPullRequest ignores older and look-alike branches", async (t) => {
  const fake = await fakeGithubPulls(t, {
    pulls: [
      githubPull(3, {
        headRef: "ticket/12-old",
        state: "CLOSED",
        createdAt: "2026-11-01T10:00:00Z",
      }),
      githubPull(4, { headRef: "fix-120", createdAt: at(60) }),
      githubPull(5, {
        headRef: "ticket/12-fork",
        headRepo: "mallory/app",
        createdAt: at(70),
      }),
      githubPull(8, {
        headRef: "dependabot/npm_and_yarn/lodash-4.17.12",
        author: { login: "dependabot[bot]", type: "Bot" },
        createdAt: at(80),
      }),
      githubPull(9, { headRef: "renovate/node-12.x", createdAt: at(81) }),
      githubPull(10, { headRef: "release/12", createdAt: at(82) }),
      githubPull(11, {
        headRef: "ticket/12-bot",
        author: { login: "helper[bot]", type: "User" },
        createdAt: at(83),
      }),
      githubPull(12, {
        headRef: "12-bot",
        author: { login: "ci", type: "Bot" },
        createdAt: at(84),
      }),
    ],
  });
  const access = accessFor(fake);
  const ticket = { key: "acme/app#12", since: SINCE };
  assert.equal(await findPullRequest(access, ticket), null);
  fake.pulls.push(githubPull(7, { headRef: "feature/12-x", createdAt: at(90) }));
  const pr = await findPullRequest(access, ticket);
  assert.equal(pr.number, 7);
  assert.equal(pr.headRef, "feature/12-x");
  // The same rules hold for the exact branch: an older attempt's PR is ignored.
  assert.equal(
    await findPullRequest(access, { ...ticket, branch: "ticket/12-old" }),
    null,
  );
});

test("findPullRequest tolerates five minutes of clock skew", async (t) => {
  const fake = await fakeGithubPulls(t, {
    pulls: [githubPull(5, { headRef: "ticket/12-fix", createdAt: at(-4) })],
  });
  const access = accessFor(fake);
  const query = { key: "acme/app#12", branch: "ticket/12-fix", since: SINCE };
  assert.equal((await findPullRequest(access, query)).number, 5);
  assert.equal(
    (await findPullRequest(access, { ...query, branch: undefined })).number,
    5,
  );
  fake.pulls[0].createdAt = at(-6);
  assert.equal(await findPullRequest(access, query), null);
  assert.equal(await findPullRequest(access, { ...query, branch: undefined }), null);
});

test("pullRequestByUrl accepts only this repository", () => {
  const access = accessFor({ fetchImpl: fetch });
  assert.deepEqual(pullRequestByUrl(access, "https://github.com/acme/app/pull/42"), {
    number: 42,
  });
  assert.deepEqual(pullRequestByUrl(access, "https://github.com/ACME/App/pull/42/"), {
    number: 42,
  });
  assert.equal(pullRequestByUrl(access, "https://github.com/other/app/pull/42"), null);
  assert.equal(pullRequestByUrl(access, "https://evil.example/acme/app/pull/42"), null);
  assert.equal(pullRequestByUrl(access, "https://github.com/acme/app/issues/42"), null);
  assert.equal(pullRequestByUrl(access, "not a url"), null);
});

test("readPullRequest maps checks, reviews and repository merge settings", async (t) => {
  const fake = await fakeGithubPulls(t, {
    repo: { defaultMergeMethod: "REBASE", mergeQueues: ["main"] },
    pulls: [
      githubPull(9, {
        headRef: "ticket/9-\u0007x",
        mergeStateStatus: "BLOCKED",
        reviewDecision: "REVIEW_REQUIRED",
        autoMerge: true,
        contexts: [
          {
            __typename: "CheckRun",
            name: "build\u0000\n" + "x".repeat(120),
            status: "COMPLETED",
            conclusion: "SUCCESS",
            isRequired: true,
          },
          {
            __typename: "CheckRun",
            name: "e2e",
            status: "IN_PROGRESS",
            conclusion: null,
            isRequired: true,
          },
          {
            __typename: "CheckRun",
            name: "lint",
            status: "COMPLETED",
            conclusion: "TIMED_OUT",
            isRequired: false,
          },
          {
            __typename: "CheckRun",
            name: "docs",
            status: "COMPLETED",
            conclusion: "SKIPPED",
            isRequired: false,
          },
          {
            __typename: "CheckRun",
            name: "old",
            status: "COMPLETED",
            conclusion: "STALE",
            isRequired: false,
          },
          { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
          { __typename: "StatusContext", context: "ci/wait", state: "EXPECTED" },
        ],
      }),
    ],
  });
  const snapshot = await readPullRequest(accessFor(fake), 9);
  assert.deepEqual(snapshot, {
    id: "PR_9",
    number: 9,
    url: "https://github.com/acme/app/pull/9",
    state: "OPEN",
    headRef: "ticket/9-x",
    headSha: githubPull(9).headSha,
    baseRef: "main",
    mergeable: "MERGEABLE",
    mergeStateStatus: "BLOCKED",
    reviewDecision: "REVIEW_REQUIRED",
    autoMerge: true,
    inMergeQueue: false,
    checks: [
      { name: `build ${"x".repeat(74)}`, state: "success", required: true },
      { name: "e2e", state: "pending", required: true },
      { name: "lint", state: "failure", required: false },
      { name: "docs", state: "success", required: false },
      { name: "old", state: "failure", required: false },
      { name: "ci/legacy", state: "failure", required: false },
      { name: "ci/wait", state: "pending", required: false },
    ],
    repo: {
      autoMergeAllowed: true,
      mergeQueue: true,
      defaultMergeMethod: "REBASE",
      defaultBranch: "main",
    },
  });
  const graph = fake.calls.filter((call) => call.path === "/graphql");
  assert.equal(graph.length, 1);
  assert.equal(graph[0].authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(graph[0].body.variables, { owner: "acme", repo: "app", n: 9 });
});

test("readPullRequest reads the merge queue of a non-default base", async (t) => {
  const fake = await fakeGithubPulls(t, {
    repo: { mergeQueues: ["release"] },
    pulls: [githubPull(2, { baseRef: "release" })],
  });
  const snapshot = await readPullRequest(accessFor(fake), 2);
  assert.equal(snapshot.repo.mergeQueue, true);
  assert.equal(snapshot.baseRef, "release");
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[1].body.variables.branch, "release");
});

test("readPullRequest caps checks at 100 and rejects a missing pull request", async (t) => {
  const contexts = Array.from({ length: 130 }, (_, index) => ({
    __typename: "StatusContext",
    context: `c${index}`,
    state: "SUCCESS",
  }));
  const fake = await fakeGithubPulls(t, { pulls: [githubPull(1, { contexts })] });
  const access = accessFor(fake);
  assert.equal((await readPullRequest(access, 1)).checks.length, 100);
  await assert.rejects(readPullRequest(access, 99), { code: "notFound" });
});

test("readPullRequest works against GitHub Enterprise", async (t) => {
  const fake = await fakeGithubPulls(t, { pulls: [githubPull(3)] });
  const access = { ...accessFor(fake, "https://ghe.example/api/v3"), host: undefined };
  assert.equal((await readPullRequest(access, 3)).number, 3);
  assert.equal(fake.calls[0].path, "/api/graphql");
  assert.equal(await defaultBranch(access), "main");
  assert.equal(fake.calls[1].path, "/api/v3/repos/acme/app");
});

test("merge sends the head sha", async (t) => {
  const fake = await fakeGithubPulls(t, { pulls: [githubPull(4)] });
  const access = accessFor(fake);
  const pr = await readPullRequest(access, 4);
  await mergePullRequest(access, pr);
  const put = fake.calls.find((call) => call.method === "PUT");
  assert.equal(put.path, "/repos/acme/app/pulls/4/merge");
  assert.deepEqual(put.body, { sha: pr.headSha, merge_method: "squash" });
  assert.equal(fake.pulls[0].state, "MERGED");
  // A moved head is refused by GitHub, never merged.
  fake.pulls.push(githubPull(5));
  const stale = { ...(await readPullRequest(access, 5)), headSha: "b".repeat(40) };
  await assert.rejects(mergePullRequest(access, stale), { code: "invalidResponse" });
  assert.equal(fake.pulls[1].state, "OPEN");
});

test("auto-merge, enqueue and their reversals send their mutations", async (t) => {
  const fake = await fakeGithubPulls(t, { pulls: [githubPull(8)] });
  const access = accessFor(fake);
  const pr = await readPullRequest(access, 8);
  fake.calls.length = 0;
  await enableAutoMerge(access, pr);
  assert.equal(fake.pulls[0].autoMerge, true);
  await disableAutoMerge(access, pr);
  assert.equal(fake.pulls[0].autoMerge, false);
  await enqueue(access, pr);
  assert.equal(fake.pulls[0].inMergeQueue, true);
  await dequeue(access, pr);
  assert.equal(fake.pulls[0].inMergeQueue, false);
  const sent = fake.calls.map((call) => ({
    name: /\{\s*(\w+)\(/.exec(call.body.query)[1],
    input: call.body.variables.input,
  }));
  assert.deepEqual(sent, [
    {
      name: "enablePullRequestAutoMerge",
      input: {
        pullRequestId: "PR_8",
        mergeMethod: "SQUASH",
        expectedHeadOid: pr.headSha,
      },
    },
    { name: "disablePullRequestAutoMerge", input: { pullRequestId: "PR_8" } },
    {
      name: "enqueuePullRequest",
      input: { pullRequestId: "PR_8", expectedHeadOid: pr.headSha },
    },
    { name: "dequeuePullRequest", input: { id: "PR_8" } },
  ]);
  for (const call of fake.calls) assert.match(call.body.query, /^mutation/);
});

test("graphql errors become invalidResponse", async (t) => {
  const fake = await fakeGithubPulls(t, {
    pulls: [githubPull(1)],
    failures: {
      "POST /graphql": { errors: [{ type: "FORBIDDEN", message: `bad ${TOKEN}` }] },
    },
  });
  const access = accessFor(fake);
  const error = await readPullRequest(access, 1).catch((caught) => caught);
  assert.equal(error.code, "invalidResponse");
  assert.doesNotMatch(error.message, new RegExp(TOKEN));
  assert.doesNotMatch(String(error.stack), new RegExp(TOKEN));
  await assert.rejects(
    enableAutoMerge(access, { id: "PR_1", headSha: "a".repeat(40), repo: {} }),
    {
      code: "invalidResponse",
    },
  );
});

test("graphql rate limits and HTTP failures keep their codes", async (t) => {
  const limited = await fakeGithubPulls(t, {
    failures: { "POST /graphql": { errors: [{ type: "RATE_LIMITED", message: "x" }] } },
  });
  await assert.rejects(readPullRequest(accessFor(limited), 1), { code: "rateLimited" });
  const down = await fakeGithubPulls(t, {
    failures: { "POST /graphql": 502, "GET /repos/acme/app/pulls": 401 },
  });
  await assert.rejects(readPullRequest(accessFor(down), 1), { code: "unavailable" });
  await assert.rejects(findPullRequest(accessFor(down), { key: "acme/app#1" }), {
    code: "unauthorized",
  });
});

test("partial graphql errors keep usable data", async (t) => {
  const fake = await fakeGithubPulls(t, {
    pulls: [githubPull(1)],
    graphqlErrors: [{ type: "FORBIDDEN", path: ["repository", "mergeQueue"] }],
  });
  const access = accessFor(fake);
  const pr = await readPullRequest(access, 1);
  assert.equal(pr.number, 1);
  await enableAutoMerge(access, pr);
  assert.equal(fake.pulls[0].autoMerge, true);
});

test("a missing repository maps to notFound", async (t) => {
  const fake = await fakeGithubPulls(t, {
    failures: {
      "POST /graphql": {
        data: { repository: null },
        errors: [{ type: "NOT_FOUND", path: ["repository"] }],
      },
    },
  });
  await assert.rejects(readPullRequest(accessFor(fake), 1), { code: "notFound" });
});

test("arming and merging refuse a missing head sha", async (t) => {
  const fake = await fakeGithubPulls(t, { pulls: [githubPull(1)] });
  const access = accessFor(fake);
  const pr = { ...(await readPullRequest(access, 1)), headSha: "" };
  fake.calls.length = 0;
  for (const action of [enableAutoMerge, enqueue, mergePullRequest])
    await assert.rejects(action(access, pr), { code: "invalidResponse" });
  assert.equal(fake.calls.length, 0);
  assert.equal(fake.pulls[0].autoMerge, false);
  assert.equal(fake.pulls[0].state, "OPEN");
});
