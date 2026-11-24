import assert from "node:assert/strict";
import test from "node:test";
import { orderView } from "../../server/features/autopilot/order-view.js";

const ref = {
  id: "order-1",
  projectId: "project-1",
  projectRoot: "/project-1",
  managed: true,
};
const run = {
  id: "run-1",
  projectId: ref.projectId,
  status: "awaiting-human",
  currentNodeId: "review",
  pullRequestUrl: "https://example.org/one/repo/pull/2",
  nodes: [
    {
      id: "review",
      verdict: {
        findings: [{ title: "Broken link", severity: "low", detail: "line 4" }],
      },
    },
  ],
};

test("a historical batch shows the scoped run, actual gate, PR and findings", async () => {
  const doc = {
    projectId: "wrong-project",
    title: "Rollout",
    implementationAuthorized: true,
    status: "implementing",
    checkpoint: "Review",
    nextAction: "Answer the gate",
    batches: [
      { id: "first", title: "Backend", status: "running", runId: run.id },
      { id: "second", title: "UI", dependsOn: ["first"], status: "planned" },
    ],
  };
  const view = await orderView(
    {
      ref,
      document: doc,
      session: { id: "session-1", status: "running", token: "secret" },
    },
    { pipelines: { store: { get: () => run } } },
  );
  assert.deepEqual(
    view.batches.map((b) => b.id),
    ["first", "second"],
  );
  assert.deepEqual(view.batches[1].dependsOn, ["first"]);
  assert.equal(view.batches[0].runs[0].status, "awaiting-human");
  assert.equal(view.runs[0].gate.link, "/pipelines/runs/run-1");
  assert.equal(view.runs[0].gate.stage, "review");
  assert.equal(view.state, "waiting");
  assert.equal(view.pullRequests[0].url, run.pullRequestUrl);
  assert.equal(view.findings[0].url, "/pipelines/runs/run-1");
  assert.equal(view.findings[0].detail, "line 4");
  assert.equal(view.allowMerge, false);
  assert.equal(view.projectId, "project-1");
  assert.equal(view.session.link, "/sessions/session-1/chat");
  assert.ok(!JSON.stringify(view).includes("secret"));
  assert.equal(view.counts.batches.total, 2);
});

test("unmapped historical orders expose limitations without linking foreign resources", async () => {
  const doc = {
    status: "active",
    worktree: "/another/project",
    sessionId: "other-session",
    projectId: "other-project",
    mergeAuthorized: true,
    tickets: [{ key: "#3", url: "javascript:confirm()", token: "secret" }],
    batches: [{ title: "old batch", runId: "other-run", runUrl: "https://other/run" }],
  };
  const view = await orderView(
    { ref: { ...ref, managed: false }, document: doc, limitations: ["legacy"] },
    {
      pipelines: {
        store: { get: () => ({ ...run, id: "other-run", projectId: "other-project" }) },
      },
    },
  );
  assert.equal(view.session, null);
  assert.equal(view.allowMerge, false);
  assert.equal(view.batches[0].id, null);
  assert.ok(view.limitations.includes("missingItemId"));
  assert.equal(view.tickets[0].source, null);
  assert.equal(view.tickets[0].url, null);
  assert.equal(view.runs[0].link, null);
  assert.equal(view.runs[0].status, null);
  assert.equal(view.findings.length, 0);
  for (const unsafe of [
    "javascript:",
    "https://other/run",
    "secret",
    "other-session",
    "/another/project",
  ])
    assert.ok(!JSON.stringify(view).includes(unsafe), unsafe);
});

test("draft and approved order preserve stable item IDs, dependencies and permission independently", async () => {
  const doc = {
    status: "implementing",
    manualPaused: true,
    planStatus: "draft",
    allowMerge: true,
    draftBatches: [
      {
        id: "draft",
        items: [
          { id: "a", status: "draft" },
          { id: "b", dependsOn: ["a"] },
        ],
      },
    ],
    batches: [{ id: "reserved", items: [] }],
  };
  const view = await orderView({ ref, document: doc }, {});
  assert.equal(view.allowMerge, true);
  assert.equal(view.implementationAuthorized, false);
  assert.equal(view.status, "paused");
  assert.equal(view.state, "paused");
  assert.equal(view.reportedStatus, "implementing");
  assert.deepEqual(
    view.draftBatches[0].items.map((i) => i.id),
    ["a", "b"],
  );
  assert.deepEqual(view.draftBatches[0].items[1].dependsOn, ["a"]);
  assert.equal(view.counts.batches.total, 1);
});

test("only exact configured ticket and PR references receive provider reads, scoped and deduplicated", async () => {
  const url = "https://example.org/one/repo/issues/3";
  const planeUrl = "https://work.example.org/team/browse/APP-42/";
  const good = { source: "github", key: "one/repo#3", url };
  const plane = { source: "plane", key: "APP-42", url: planeUrl };
  const reads = [];
  const services = {
    tickets: {
      accesses: async (project) => {
        assert.deepEqual(project, { id: ref.projectId, path: ref.projectRoot });
        return {
          github: { owner: "one", repo: "repo", host: "https://example.org" },
          plane: {
            baseUrl: "https://work.example.org",
            workspaceSlug: "team",
            identifier: "APP",
            projectId: "uuid",
          },
        };
      },
      sources: Object.fromEntries(
        [good, plane].map((ticket) => [
          ticket.source,
          {
            get: async (_access, key) => {
              reads.push(key);
              return { ...ticket, id: "source-id", title: "Live title", state: "open" };
            },
          },
        ]),
      ),
    },
  };
  const document = {
    tickets: [
      good,
      plane,
      { ...good, url: "https://wrong.example/one/repo/issues/3" },
      { source: "linear", key: "APP-42" },
      { ...good, url: "https://user:token@example.org/x" },
    ],
    batches: [{ id: "b", items: [{ id: "i", tickets: [good] }] }],
  };
  const list = await orderView({ ref, document }, services);
  assert.deepEqual(reads, []);
  assert.equal(list.tickets[0].resolution, "recorded");
  const view = await orderView({ ref, document }, services, { remote: true });
  assert.deepEqual(reads.sort(), ["APP-42", "one/repo#3"]);
  assert.equal(view.tickets.find((t) => t.url === url).status, "open");
  assert.equal(view.tickets.find((t) => t.url === planeUrl).resolution, "live");
  assert.equal(view.batches[0].items[0].tickets[0].title, "Live title");
  assert.ok(!JSON.stringify(view).includes("user:token"));
});

test("source PR state supersedes recorded completion and keeps the run's evidence", async () => {
  const reads = [];
  const services = {
    tickets: {
      accesses: async () => ({
        github: {
          owner: "one",
          repo: "repo",
          host: "https://example.org",
          apiBase: "https://example.org/api/v3",
          token: "secret",
          fetchImpl: async (url, options) => {
            reads.push([url, JSON.parse(options.body).variables]);
            const pullRequest = {
              id: "pull-2",
              number: 2,
              state: "OPEN",
              url: run.pullRequestUrl,
            };
            return Response.json({ data: { repository: { pullRequest } } });
          },
        },
      }),
    },
    pipelines: { store: { get: () => ({ ...run, status: "completed" }) } },
  };
  const document = {
    status: "completed",
    batches: [
      {
        id: "b",
        status: "done",
        runId: run.id,
        pr: { url: run.pullRequestUrl, status: "merged" },
      },
    ],
    pullRequests: [
      {
        source: "gitlab",
        url: "https://gitlab.example/merge_requests/5",
        status: "merged",
      },
    ],
  };
  const view = await orderView({ ref, document }, services, { remote: true });
  assert.deepEqual(reads, [
    ["https://example.org/api/graphql", { owner: "one", repo: "repo", n: 2 }],
  ]);
  assert.equal(view.hasOpenWork, true);
  assert.equal(view.pullRequests.find((p) => p.source === "github").status, "open");
  assert.equal(
    view.pullRequests.find((p) => p.source === "gitlab").resolution,
    "recorded",
  );
});

test("a linked run URL alone does not erase the recorded state of its PR on a list read", async () => {
  const view = await orderView(
    {
      ref,
      document: {
        status: "completed",
        batches: [
          {
            id: "a",
            status: "done",
            runId: run.id,
            pr: { source: "github", url: run.pullRequestUrl, status: "open" },
          },
        ],
      },
    },
    { pipelines: { store: { get: () => ({ ...run, status: "completed" }) } } },
  );
  assert.equal(view.hasOpenWork, true);
  assert.equal(view.pullRequests[0].status, "open");
  assert.equal(view.batches[0].pullRequests[0].status, "open");
});

test("live owner questions and the register's cleanup context survive an unreadable order", async () => {
  const view = await orderView(
    {
      ref: {
        ...ref,
        filename: "archived.json",
        cleanup: true,
        resources: {
          workspace: { cwd: "/owned", branch: "autopilot/1", ownership: "private" },
        },
        selection: { tool: "codex", secret: "private" },
      },
      document: null,
      limitations: ["orderFileUnavailable"],
      session: { id: "known", status: "running" },
    },
    {
      requests: {
        listAll: () => [
          {
            id: "a",
            sessionId: "other",
            kind: "question",
            questions: [{ prompt: "Unrelated question" }],
          },
          {
            id: "b",
            sessionId: "known",
            kind: "question",
            questions: [{ prompt: "Which branch?" }],
          },
        ],
      },
    },
  );
  assert.deepEqual(view.requests, [
    { id: "b", kind: "question", title: "Which branch?", link: "/sessions/known/chat" },
  ]);
  assert.equal(view.state, "waiting");
  assert.equal(view.title, "archived");
  assert.equal(view.cleanup, true);
  assert.equal(view.worktree, "/owned");
  assert.equal(view.projectName, "project-1");
  assert.deepEqual(view.selection, { tool: "codex" });
  assert.ok(!JSON.stringify(view).includes("private"));
});

test("a closed superseded PR remains visible on a completed order without blocking cleanup", async () => {
  const view = await orderView(
    {
      ref,
      document: {
        status: "completed",
        pullRequests: [{ url: run.pullRequestUrl, status: "closed" }],
      },
    },
    {},
  );
  assert.equal(view.pullRequests[0].status, "closed");
  assert.equal(view.state, "completed");
  assert.equal(view.hasOpenWork, false);
});
