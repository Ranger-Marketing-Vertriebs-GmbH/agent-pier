import test from "node:test";
import assert from "node:assert/strict";

import {
  githubSource,
  parseGithubRemote,
} from "../../server/features/tickets/sources/github.js";
import { ticketSources } from "../../server/features/tickets/sources/index.js";
import { githubApiBase } from "../../server/features/repositories/github-token-check.js";
import { fakeGithub, githubIssue } from "../helpers/ticket-fakes.js";
import { setup } from "../helpers/repositories.js";

function accessFor(fake) {
  return {
    apiBase: "https://api.github.com",
    owner: "acme",
    repo: "app",
    token: "gh-token",
    fetchImpl: fake.fetchImpl,
  };
}

test("parses HTTPS, SCP and ssh remotes", () => {
  assert.deepEqual(parseGithubRemote("git@github.com:acme/app.git"), {
    host: "https://github.com",
    owner: "acme",
    repo: "app",
  });
  assert.deepEqual(parseGithubRemote("https://ghe.example.com/acme/app"), {
    host: "https://ghe.example.com",
    owner: "acme",
    repo: "app",
  });
  assert.deepEqual(parseGithubRemote("ssh://git@github.com/acme/app.git"), {
    host: "https://github.com",
    owner: "acme",
    repo: "app",
  });
  assert.equal(parseGithubRemote(""), null);
  assert.equal(parseGithubRemote("/local/path"), null);
  assert.equal(parseGithubRemote("https://github.com/acme"), null);
  assert.equal(parseGithubRemote("https://github.com/a/b/c"), null);
  assert.equal(ticketSources.github, githubSource);
});

test("drops pull requests and follows pages", async (t) => {
  const issues = [];
  for (let n = 1; n <= 170; n += 1) {
    const labels = [{ name: n % 2 ? "feature" : "bug" }];
    // Pull requests are every ninth entry, so both pages hold some.
    issues.push(
      githubIssue(n, n % 9 === 0 && n <= 180 ? { pull_request: {}, labels } : { labels }),
    );
  }
  const prs = issues.filter((issue) => issue.pull_request).length;
  const fake = await fakeGithub(t, { issues });
  const { tickets, labels } = await githubSource.list(accessFor(fake), {});
  assert.equal(tickets.length, 170 - prs);
  assert.ok(tickets.every((item) => item.key.startsWith("acme/app#")));
  assert.deepEqual(
    fake.calls.map((c) => c.path),
    [
      "/repos/acme/app/issues?state=open&per_page=100&page=1",
      "/repos/acme/app/issues?state=open&per_page=100&page=2",
    ],
  );
  assert.equal(fake.calls[0].authorization, "Bearer gh-token");
  assert.deepEqual(labels, ["bug", "feature"]);
});

test("a label filter keeps the labels of every open issue", async (t) => {
  const fake = await fakeGithub(t, {
    issues: [
      githubIssue(1, { labels: [{ name: "bug" }] }),
      githubIssue(2, { labels: [{ name: "feature" }] }),
    ],
  });
  const { tickets, labels } = await githubSource.list(accessFor(fake), { label: "bug" });
  assert.deepEqual(
    tickets.map((item) => item.key),
    ["acme/app#1"],
  );
  assert.deepEqual(labels, ["bug", "feature"]);
  assert.equal(
    fake.calls[0].path,
    "/repos/acme/app/issues?state=open&per_page=100&page=1",
  );
});

test("an Enterprise remote maps to its /api/v3 base", () => {
  const remote = parseGithubRemote("git@ghe.example.com:acme/app.git");
  assert.equal(githubApiBase(remote.host), "https://ghe.example.com/api/v3");
  assert.equal(
    githubApiBase(parseGithubRemote("https://github.com/acme/app").host),
    "https://api.github.com",
  );
});

test("stops after three pages", async (t) => {
  const issues = Array.from({ length: 400 }, (_, i) => githubIssue(i + 1));
  const fake = await fakeGithub(t, { issues });
  const { tickets } = await githubSource.list(accessFor(fake), {});
  assert.equal(tickets.length, 300);
  assert.equal(fake.calls.length, 3);
});

test("maps the issue fields and reports tracker failures by code", async (t) => {
  const fake = await fakeGithub(t, {
    issues: [githubIssue(5, { body: "Hello", labels: [{ name: "bug" }] })],
  });
  const ticket = await githubSource.get(accessFor(fake), "acme/app#5");
  assert.deepEqual(ticket, {
    source: "github",
    key: "acme/app#5",
    number: 5,
    id: "5",
    title: "Issue 5",
    body: "Hello",
    url: "https://github.com/acme/app/issues/5",
    labels: ["bug"],
    state: "open",
    updatedAt: "2026-11-01T10:00:00Z",
  });
  const denied = await fakeGithub(t, {
    failures: { "GET /repos/acme/app/issues": 403 },
  });
  await assert.rejects(githubSource.list(accessFor(denied), {}), { code: "forbidden" });
});

test("get refuses a pull request and a key of another repository", async (t) => {
  const fake = await fakeGithub(t, {
    issues: [githubIssue(1), githubIssue(99, { pull_request: {} })],
  });
  const access = accessFor(fake);
  await assert.rejects(githubSource.get(access, "other/repo#1"), { code: "notFound" });
  await assert.rejects(githubSource.get(access, "acme/app#99"), { code: "notFound" });
  await assert.rejects(githubSource.get(access, "acme/app#404"), { code: "notFound" });
  assert.equal(fake.calls.length, 2);
});

test("in progress adds the label and a comment without a link", async (t) => {
  const fake = await fakeGithub(t, { issues: [githubIssue(7)] });
  const access = accessFor(fake);
  const ticket = await githubSource.get(access, "acme/app#7");
  const done = await githubSource.markInProgress(access, ticket, {
    kind: "session",
    label: "in progress",
  });
  assert.deepEqual(done, { state: "done" });
  assert.deepEqual(
    fake.calls.slice(-2).map((c) => [c.method, c.path, c.body]),
    [
      ["POST", "/repos/acme/app/issues/7/labels", { labels: ["in progress"] }],
      [
        "POST",
        "/repos/acme/app/issues/7/comments",
        { body: "Started in AgentPier (session)." },
      ],
    ],
  );
  await githubSource.markInProgress(access, ticket, {
    kind: "run",
  });
  assert.deepEqual(fake.calls.at(-2).body, { labels: ["in progress"] });
  assert.equal(fake.calls.at(-1).body.body, "Started in AgentPier (pipeline run).");
  for (const call of fake.calls.filter((c) => c.path.endsWith("/comments")))
    assert.doesNotMatch(call.body.body, /https?:|\/\/|localhost|127\.0\.0\.1/);
});

test("a refused label write fails markInProgress without commenting", async (t) => {
  const fake = await fakeGithub(t, {
    issues: [githubIssue(7)],
    failures: { "POST /repos/acme/app/issues/7/labels": 403 },
  });
  const access = accessFor(fake);
  const ticket = await githubSource.get(access, "acme/app#7");
  await assert.rejects(
    githubSource.markInProgress(access, ticket, {
      kind: "session",
    }),
    { code: "forbidden" },
  );
  assert.ok(!fake.calls.some((c) => c.path.endsWith("/comments")));
});

test("RepositoryStore#token reads the saved token only", (t) => {
  const { store } = setup(t);
  const credential = store.createCredential({
    name: "W",
    host: "github.com",
    token: "gh-token",
  });
  assert.equal(store.token(credential.id), "gh-token");
  assert.equal(store.token("missing"), null);
  assert.equal(store.token("../repositories"), null);
});
