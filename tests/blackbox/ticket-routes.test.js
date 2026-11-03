import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { signedInUser } from "../helpers/users.js";
import { fakePlane } from "../helpers/ticket-fakes.js";

const planeProjectId = "11111111-1111-4111-8111-111111111111";

function captureConsole(t) {
  const lines = [];
  for (const method of ["log", "warn", "error", "info"])
    t.mock.method(console, method, (...args) => lines.push(args.map(String).join(" ")));
  return lines;
}

test("connection routes never answer or log the token", async (t) => {
  // The fake answers only "plane-token"; this connection's token is refused (401).
  const plane = await fakePlane(t, {
    projects: [{ id: planeProjectId, identifier: "AP", name: "AgentPier" }],
  });
  const fetched = [];
  const f = await applicationFixture(t, {
    ticketFetch: (url, init) => {
      fetched.push(String(url));
      return fetch(url, init);
    },
  });
  const logged = captureConsole(t);
  const responses = [];
  const call = async (endpoint, options) => {
    const response = await f.request(endpoint, options);
    const text = await response.text();
    responses.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const created = await call("/api/ticket-connections", {
    method: "POST",
    body: {
      name: "Plane",
      baseUrl: plane.baseUrl,
      workspaceSlug: "acme",
      token: "plane-secret",
    },
  });
  assert.equal(created.status, 201);
  const id = created.body.connection.id;
  assert.equal(created.body.connection.hasSecret, true);
  const list = await call("/api/ticket-connections");
  assert.deepEqual(
    list.body.connections.map((c) => c.id),
    [id],
  );
  const updated = await call(`/api/ticket-connections/${id}`, {
    method: "PUT",
    body: { name: "Plane 2", token: "plane-secret-2" },
  });
  assert.equal(updated.body.connection.name, "Plane 2");
  const refused = await call(`/api/ticket-connections/${id}/projects`);
  assert.equal(refused.status, 502);
  assert.ok(fetched.some((url) => url.startsWith(plane.baseUrl)));
  // With the token the fake accepts, the projects and states come through.
  await call(`/api/ticket-connections/${id}`, {
    method: "PUT",
    body: { token: "plane-token" },
  });
  const projects = await call(`/api/ticket-connections/${id}/projects`);
  assert.deepEqual(projects.body, {
    projects: [{ id: planeProjectId, identifier: "AP", name: "AgentPier" }],
  });
  const states = await call(
    `/api/ticket-connections/${id}/projects/${planeProjectId}/states`,
  );
  assert.deepEqual(states.body, { states: [] });
  for (const body of responses) {
    assert.equal(body.includes("plane-secret"), false);
    assert.equal(body.includes("plane-token"), false);
  }
  assert.equal(logged.join("\n").includes("plane-secret"), false);
  assert.equal(logged.join("\n").includes("plane-token"), false);
  assert.equal(
    (await call(`/api/ticket-connections/${id}`, { method: "DELETE" })).status,
    204,
  );
  assert.deepEqual((await call("/api/ticket-connections")).body, { connections: [] });
});

test("a project links Plane and lists its tickets next to an unconnected GitHub", async (t) => {
  const plane = await fakePlane(t, {
    projects: [{ id: planeProjectId, identifier: "AP", name: "AgentPier" }],
    states: [{ id: "s-todo", name: "Todo", group: "unstarted", sequence: 1 }],
    items: [
      {
        id: "uuid-1",
        sequence_id: 1,
        project: planeProjectId,
        name: "First",
        description_html: "<p>Body</p>",
        state: "s-todo",
        labels: [],
        updated_at: "2026-11-01T10:00:00Z",
      },
    ],
  });
  const f = await applicationFixture(t);
  const project = await f.application.memory.register(f.project);
  const created = await f.request("/api/ticket-connections", {
    method: "POST",
    body: {
      name: "Plane",
      baseUrl: plane.baseUrl,
      workspaceSlug: "acme",
      token: "plane-token",
    },
  });
  const { connection } = await created.json();
  const linked = await f.request(`/api/tickets/projects/${project.id}/sources`, {
    method: "PUT",
    body: { plane: { connectionId: connection.id, planeProjectId, identifier: "X" } },
  });
  assert.equal(linked.status, 200);
  const view = await linked.json();
  assert.equal(view.project.path, f.project);
  assert.equal(view.sources.plane.identifier, "AP");
  assert.equal(view.sources.github.state, "notConnected");
  const listed = await f.request(`/api/tickets/projects/${project.id}/tickets`);
  const { tickets, errors } = await listed.json();
  assert.deepEqual(errors, [{ source: "github", code: "notConnected" }]);
  assert.deepEqual(
    tickets.map((x) => x.key),
    ["AP-1"],
  );
  const bad = await f.request(`/api/tickets/projects/${project.id}/tickets?source=jira`);
  assert.equal(bad.status, 400);
  const start = await f.request(`/api/tickets/projects/${project.id}/start`, {
    method: "POST",
    body: { source: "plane", key: "AP-1", kind: "nothing" },
  });
  assert.equal(start.status, 400);
  const missing = await f.request("/api/tickets/projects/unknown-project");
  assert.equal(missing.status, 404);
});

test("a restricted user reaches no ticket route", async (t) => {
  const f = await applicationFixture(t);
  const { cookie } = await signedInUser(f);
  const headers = { cookie };
  assert.equal((await f.request("/api/ticket-connections", { headers })).status, 404);
  assert.equal((await f.request("/api/tickets/projects/p1", { headers })).status, 404);
  const post = await f.request("/api/ticket-connections", {
    method: "POST",
    headers,
    body: { name: "P", baseUrl: "https://api.plane.so", workspaceSlug: "a", token: "x" },
  });
  assert.ok([403, 404].includes(post.status));
  const start = await f.request("/api/tickets/projects/p1/start", {
    method: "POST",
    headers,
    body: {},
  });
  assert.ok([403, 404].includes(start.status));
  assert.deepEqual(f.application.ticketStore.listConnections(), []);
});

test("GitHub credential writes signal every project's Tickets tab", async (t) => {
  const f = await applicationFixture(t);
  const signals = [];
  const hub = f.application.live;
  const invalidate = hub.invalidate.bind(hub);
  t.mock.method(hub, "invalidate", (name, param) => {
    signals.push([name, param]);
    return invalidate(name, param);
  });
  const ticketSignals = () => signals.filter(([name]) => name === "tickets.project");
  const created = await f.request("/api/git-credentials", {
    method: "POST",
    body: { name: "Work", host: "github.com", token: "github-secret" },
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.deepEqual(ticketSignals(), [["tickets.project", undefined]]);
  const updated = await f.request(`/api/git-credentials/${id}`, {
    method: "PATCH",
    body: { name: "Work 2", agentDefault: true },
  });
  assert.equal(updated.status, 200);
  assert.equal(ticketSignals().length, 2);
  const removed = await f.request(`/api/git-credentials/${id}`, { method: "DELETE" });
  assert.equal(removed.status, 204);
  assert.equal(ticketSignals().length, 3);
});
