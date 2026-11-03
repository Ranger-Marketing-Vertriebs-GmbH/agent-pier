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
  assert.equal((await planeSource.list(access, {})).truncated, false);
});

test("a read that stops at five pages says it is truncated", async (t) => {
  const many = Array.from({ length: 501 }, (_, i) => item(i + 1));
  const { fake, access } = await setup(t, { items: many });
  const read = await planeSource.list(access, {});
  assert.equal(read.tickets.length, 500);
  assert.equal(read.truncated, true);
  assert.equal(fake.calls.filter((c) => /\/work-items\/\?/.test(c.path)).length, 5);
  const { access: exact } = await setup(t, { items: many.slice(0, 500) });
  assert.equal((await planeSource.list(exact, {})).truncated, false);
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
        { comment_html: "<p>Started in AgentPier (pipeline run).</p>" },
      ],
    ],
  );
});

test("the comments name AgentPier and the kind but carry no address", async (t) => {
  const { fake, access } = await setup(t, { items: [item(1)] });
  const [ticket] = (await planeSource.list(access, {})).tickets;
  await planeSource.markInProgress(access, ticket, { kind: "session" });
  const post = fake.calls.find((c) => c.method === "POST");
  assert.equal(post.body.comment_html, "<p>Started in AgentPier (session).</p>");
  assert.doesNotMatch(post.body.comment_html, /https?:|\/\/|href|localhost|127\.0\.0\.1/);
});

test("a configured started state wins; an item already started is not patched", async (t) => {
  const items = [item(1), item(2, { state: "s-late" })];
  const { fake, access } = await setup(t, { items });
  const { tickets } = await planeSource.list(access, {});
  const configured = { ...access, inProgressStateId: "s-late" };
  await planeSource.markInProgress(configured, tickets[0], {
    kind: "session",
  });
  assert.deepEqual(
    fake.calls.filter((c) => c.method === "PATCH").map((c) => c.body),
    [{ state: "s-late" }],
  );
  fake.calls.length = 0;
  await planeSource.markInProgress(access, tickets[1], {
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
  await assert.rejects(planeSource.markInProgress(access, ticket, { kind: "session" }), {
    code: "forbidden",
  });
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
      { kind: "session" },
    ),
    { code: "invalidResponse" },
  );
});

test("planeWebUrl maps Plane Cloud's API host to the app host", () => {
  assert.equal(planeWebUrl("https://api.plane.so"), "https://app.plane.so");
  assert.equal(planeWebUrl("https://plane.example.com"), "https://plane.example.com");
  assert.equal(ticketSources.plane, planeSource);
});

const PR = "https://github.com/acme/app/pull/9";
const DONE_STATES = [
  { id: "B", name: "Shipped", group: "completed", sequence: 2 },
  { id: "A", name: "Done", group: "completed", sequence: 1 },
  { id: "S", name: "Started", group: "started", sequence: 3 },
];

test("plane markDone moves to the first completed state and comments", async (t) => {
  const { fake, access } = await setup(t, {
    states: DONE_STATES,
    items: [item(1, { state: "S" })],
  });
  const [ticket] = (await planeSource.list(access, {})).tickets;
  const done = await planeSource.markDone(access, ticket, { prUrl: PR });
  assert.deepEqual(done, { state: "done" });
  const base = `/api/v1/workspaces/acme/projects/${projectId}/work-items/${ticket.id}/`;
  assert.deepEqual(
    fake.calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body]),
    [
      ["PATCH", base, { state: "A" }],
      [
        "POST",
        `${base}comments/`,
        { comment_html: "<p>Done: merged in https://github.com/acme/app/pull/9.</p>" },
      ],
    ],
  );
});

test("plane markDone skips the state change when already completed", async (t) => {
  const { fake, access } = await setup(t, {
    states: DONE_STATES,
    items: [item(1, { state: "B" })],
  });
  const ticket = await planeSource.get(access, "AP-1");
  await planeSource.markDone(access, ticket, { prUrl: PR });
  assert.deepEqual(
    fake.calls.filter((c) => c.method !== "GET").map((c) => c.method),
    ["POST"],
  );
});

test("plane markDone escapes the URL and never contains the AgentPier address", async (t) => {
  const { fake, access } = await setup(t, {
    states: DONE_STATES,
    items: [item(1, { state: "S" })],
  });
  const [ticket] = (await planeSource.list(access, {})).tickets;
  await planeSource.markDone(access, ticket, { prUrl: `${PR}?a=1&b="2"` });
  const html = fake.calls.at(-1).body.comment_html;
  assert.match(html, /a=1&amp;b=%222%22/);
  assert.doesNotMatch(html, /127\.0\.0\.1|localhost|agentpier\.[a-z]/i);
});

test("plane hasLabel matches label names case-insensitively", async (t) => {
  const { access } = await setup(t, { labels: [{ id: "l-1", name: "Agent" }] });
  assert.equal(await planeSource.hasLabel(access, "agent"), true);
  assert.equal(await planeSource.hasLabel(access, " AGENT "), true);
  assert.equal(await planeSource.hasLabel(access, "other"), false);
});

test("plane started and done checks compare state ids, names only without an id", async (t) => {
  const states = [
    // An unstarted state that shares its name with the started one.
    { id: "s-ip-todo", name: "In progress", group: "unstarted", sequence: 1 },
    { id: "s-ip", name: "In progress", group: "started", sequence: 2 },
    { id: "s-done-todo", name: "Done", group: "started", sequence: 3 },
    { id: "s-done", name: "Done", group: "completed", sequence: 4 },
  ];
  const { fake, access } = await setup(t, {
    states,
    items: [item(1, { state: "s-ip-todo" }), item(2, { state: "s-done-todo" })],
  });
  const { tickets } = await planeSource.list(access, {});
  const one = tickets.find((ticket) => ticket.number === 1);
  const two = tickets.find((ticket) => ticket.number === 2);
  assert.equal(one.stateId, "s-ip-todo");
  assert.equal((await planeSource.get(access, "AP-2")).stateId, "s-done-todo");
  const patches = () =>
    fake.calls.filter((c) => c.method === "PATCH").map((c) => c.body.state);
  await planeSource.markInProgress(access, one, { kind: "session" });
  await planeSource.markDone(access, two, { prUrl: PR });
  assert.deepEqual(patches(), ["s-ip", "s-done"]);
  // A ticket read without a state id falls back to the name.
  fake.calls.length = 0;
  const { stateId: _one, ...byName } = one;
  const { stateId: _two, ...doneByName } = two;
  await planeSource.markInProgress(access, byName, { kind: "session" });
  await planeSource.markDone(access, doneByName, { prUrl: PR });
  assert.deepEqual(patches(), []);
});
