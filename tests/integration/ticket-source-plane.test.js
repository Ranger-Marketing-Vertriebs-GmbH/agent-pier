import test from "node:test";
import assert from "node:assert/strict";

import { planeSource, planeWebUrl } from "../../server/features/tickets/sources/plane.js";
import { ticketSources } from "../../server/features/tickets/sources/index.js";
import { fakePlane } from "../helpers/ticket-fakes.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const STATES = [
  { id: "s-back", name: "Backlog", group: "backlog", sequence: 1 },
  { id: "s-todo", name: "Todo", group: "unstarted", sequence: 2 },
  { id: "s-late", name: "In review", group: "started", sequence: 20 },
  { id: "s-prog", name: "In progress", group: "started", sequence: 10 },
  { id: "s-done", name: "Done", group: "completed", sequence: 30 },
  { id: "s-gone", name: "Cancelled", group: "cancelled", sequence: 40 },
];
const LABELS = [
  { id: "l-bug", name: "bug" },
  { id: "l-be", name: "backend" },
];

function item(n, extra = {}) {
  return {
    id: `uuid-${n}`,
    sequence_id: n,
    project: projectId,
    name: `Item ${n}`,
    description_html: `<p>Body ${n}</p>`,
    state: "s-todo",
    labels: [],
    updated_at: "2026-11-01T10:00:00Z",
    ...extra,
  };
}

async function setup(t, options = {}) {
  const fake = await fakePlane(t, { states: STATES, labels: LABELS, ...options });
  const access = {
    baseUrl: fake.baseUrl,
    workspaceSlug: "acme",
    projectId,
    identifier: "AP",
    token: "plane-token",
  };
  return { fake, access };
}

test("lists only open items across cursors with label names", async (t) => {
  const items = [];
  for (let n = 1; n <= 130; n += 1) {
    const state =
      n <= 100 ? ["s-prog", "s-todo", "s-back"][n % 3] : n <= 120 ? "s-done" : "s-gone";
    items.push(item(n, { state, labels: n % 2 ? ["l-bug"] : ["l-be"] }));
  }
  const { fake, access } = await setup(t, { items });
  const { tickets, labels } = await planeSource.list(access, {});
  assert.equal(tickets.length, 100);
  assert.ok(fake.calls.every((c) => c.apiKey === "plane-token"));
  const listCalls = fake.calls.filter((c) => /\/work-items\/\?/.test(c.path));
  assert.equal(listCalls.length, 2);
  assert.match(decodeURIComponent(listCalls[0].path), /per_page=100&expand=state,labels/);
  assert.equal(tickets[0].key, "AP-1");
  assert.equal(tickets[0].url, `${fake.baseUrl}/acme/browse/AP-1/`);
  assert.equal(tickets[0].body, "Body 1");
  assert.deepEqual(labels, ["backend", "bug"]);
});

test("ids are mapped to state and label names when not expanded", async (t) => {
  const items = [
    item(1, { state: "s-done" }),
    item(2, { labels: ["l-bug"], state: "s-prog" }),
  ];
  const { access } = await setup(t, { items, ids: true });
  const { tickets } = await planeSource.list(access, {});
  assert.deepEqual(
    tickets.map((x) => [x.key, x.state, x.labels]),
    [["AP-2", "In progress", ["bug"]]],
  );
});

test("a state id missing from the states list keeps the item open without a name", async (t) => {
  const items = [item(1, { state: "s-unknown" }), item(2, { state: "s-done" })];
  const { access } = await setup(t, { items, ids: true });
  const { tickets } = await planeSource.list(access, {});
  assert.deepEqual(
    tickets.map((x) => [x.key, x.state]),
    [["AP-1", ""]],
  );
  const one = await planeSource.get(access, "AP-1");
  assert.equal(one.state, "");
});

test("get accepts an item whose labels are not a list", async (t) => {
  const { access } = await setup(t, { items: [item(1, { labels: null })] });
  const ticket = await planeSource.get(access, "AP-1");
  assert.deepEqual(ticket.labels, []);
});

test("a label filter keeps items carrying that label name", async (t) => {
  const items = [item(1, { labels: ["l-bug"] }), item(2, { labels: ["l-be"] })];
  const { access } = await setup(t, { items });
  const { tickets, labels } = await planeSource.list(access, { label: "bug" });
  assert.deepEqual(
    tickets.map((x) => x.key),
    ["AP-1"],
  );
  assert.deepEqual(labels, ["backend", "bug"]);
});

test("description_stripped wins, description_html is converted", async (t) => {
  const items = [
    item(1, { description_stripped: "Plain text", description_html: "<p>Html</p>" }),
    item(2, { description_html: "<p>A &amp; B</p><p>C<br/>D</p>" }),
  ];
  const { access } = await setup(t, { items });
  const { tickets } = await planeSource.list(access, {});
  assert.equal(tickets[0].body, "Plain text");
  assert.equal(tickets[1].body, "A & B\nC\nD");
});

test("get reads by key and refuses an item of another project", async (t) => {
  const items = [item(3), item(4, { project: "other-uuid" })];
  const { fake, access } = await setup(t, { items });
  assert.equal((await planeSource.get(access, "AP-3")).id, "uuid-3");
  const before = fake.calls.length;
  await assert.rejects(planeSource.get(access, "XY-3"), { code: "notFound" });
  assert.equal(fake.calls.length, before);
  await assert.rejects(planeSource.get(access, "AP-4"), { code: "notFound" });
  await assert.rejects(planeSource.get(access, "AP-9"), { code: "notFound" });
});

test("in progress moves to the first started state and comments", async (t) => {
  const { fake, access } = await setup(t, { items: [item(1)] });
  const [ticket] = (await planeSource.list(access, {})).tickets;
  await planeSource.markInProgress(access, ticket, {
    link: "http://h/pipelines/runs/r1",
    kind: "pipeline",
  });
  const writes = fake.calls.filter((c) => c.method !== "GET");
  const base = `/api/v1/workspaces/acme/projects/${projectId}/work-items/${ticket.id}/`;
  assert.deepEqual(
    writes.map((c) => [c.method, c.path, c.body]),
    [
      ["PATCH", base, { state: "s-prog" }],
      [
        "POST",
        `${base}comments/`,
        {
          comment_html:
            '<p>Started in AgentPier: <a href="http://h/pipelines/runs/r1">pipeline run</a></p>',
        },
      ],
    ],
  );
});

test("the comment link is escaped", async (t) => {
  const { fake, access } = await setup(t, { items: [item(1)] });
  const [ticket] = (await planeSource.list(access, {})).tickets;
  await planeSource.markInProgress(access, ticket, {
    link: 'http://h/s?a=1&b="2"<x>',
    kind: "session",
  });
  const post = fake.calls.find((c) => c.method === "POST");
  assert.equal(
    post.body.comment_html,
    '<p>Started in AgentPier: <a href="http://h/s?a=1&amp;b=&quot;2&quot;&lt;x&gt;">session</a></p>',
  );
});

test("a configured started state wins; an item already started is not patched", async (t) => {
  const items = [item(1), item(2, { state: "s-late" })];
  const { fake, access } = await setup(t, { items });
  const { tickets } = await planeSource.list(access, {});
  const configured = { ...access, inProgressStateId: "s-late" };
  await planeSource.markInProgress(configured, tickets[0], {
    link: "http://h/s",
    kind: "session",
  });
  assert.deepEqual(
    fake.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
    [{ state: "s-late" }],
  );
  fake.calls.length = 0;
  await planeSource.markInProgress(access, tickets[1], {
    link: "http://h/s",
    kind: "session",
  });
  assert.deepEqual(
    fake.calls.filter((c) => c.method !== "GET").map((c) => c.method),
    ["POST"],
  );
});

test("a refused write maps to a source error", async (t) => {
  const { access } = await setup(t, {
    items: [item(1)],
    failures: {
      [`PATCH /api/v1/workspaces/acme/projects/${projectId}/work-items/uuid-1/`]: 403,
    },
  });
  const [ticket] = (await planeSource.list(access, {})).tickets;
  await assert.rejects(
    planeSource.markInProgress(access, ticket, { link: "http://h/s", kind: "session" }),
    { code: "forbidden" },
  );
});

test("a wrong token reads as unauthorized", async (t) => {
  const { access } = await setup(t, { items: [item(1)] });
  await assert.rejects(planeSource.list({ ...access, token: "nope" }, {}), {
    code: "unauthorized",
  });
});

test("projects lists id, identifier and name from an array or results", async (t) => {
  const projects = [{ id: "p1", identifier: "AP", name: "App", extra: 1 }];
  const { access } = await setup(t, { projects });
  const { workspaceSlug, baseUrl, token } = access;
  assert.deepEqual(await planeSource.projects({ workspaceSlug, baseUrl, token }), [
    { id: "p1", identifier: "AP", name: "App" },
  ]);
  const states = await planeSource.states(access);
  assert.equal(states.length, 6);
  assert.deepEqual(states[0], {
    id: "s-back",
    name: "Backlog",
    group: "backlog",
    sequence: 1,
  });
});

test("a project without a started state fails as invalidResponse", async (t) => {
  const { access } = await setup(t, { states: [STATES[0], STATES[4]], items: [item(1)] });
  await assert.rejects(
    planeSource.markInProgress(
      access,
      { id: "uuid-1", state: "Todo" },
      { link: "x", kind: "session" },
    ),
    { code: "invalidResponse" },
  );
});

test("planeWebUrl maps Plane Cloud's API host to the app host", () => {
  assert.equal(planeWebUrl("https://api.plane.so"), "https://app.plane.so");
  assert.equal(planeWebUrl("https://plane.example.com"), "https://plane.example.com");
  assert.equal(ticketSources.plane, planeSource);
});
