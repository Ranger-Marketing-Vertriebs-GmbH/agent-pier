import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
import { TicketService } from "../../server/features/tickets/ticket-service.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { fakeGithub, fakePlane, githubIssue } from "../helpers/ticket-fakes.js";

const planeProjectId = "11111111-1111-4111-8111-111111111111";
const otherPlaneProjectId = "22222222-2222-4222-8222-222222222222";
const STATES = [
  { id: "s-todo", name: "Todo", group: "unstarted", sequence: 1 },
  { id: "s-prog", name: "In progress", group: "started", sequence: 10 },
  { id: "s-done", name: "Done", group: "completed", sequence: 30 },
];
const planeItem = (n, extra = {}) => ({
  id: `uuid-${n}`,
  sequence_id: n,
  project: planeProjectId,
  name: `Item ${n}`,
  description_html: `<p>Body ${n}</p>`,
  state: "s-todo",
  labels: [],
  updated_at: `2026-11-0${n}T10:00:00Z`,
  ...extra,
});

async function setup(
  t,
  { githubFailures = {}, planeFailures = {}, tool = "claude", deliver, taken } = {},
) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-ticket-svc-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectPath = path.join(root, "app");
  const otherPath = path.join(root, "other");
  fs.mkdirSync(projectPath);
  fs.mkdirSync(otherPath);
  const github = await fakeGithub(t, {
    issues: [
      githubIssue(7, { title: "Fix login", updated_at: "2026-11-05T10:00:00Z" }),
      githubIssue(8, { labels: [{ name: "bug" }] }),
    ],
    failures: githubFailures,
  });
  const plane = await fakePlane(t, {
    projects: [
      { id: planeProjectId, identifier: "AP", name: "AgentPier" },
      { id: otherPlaneProjectId, identifier: "XY", name: "Other" },
    ],
    states: STATES,
    items: [planeItem(3), planeItem(4, { state: "s-done" })],
    failures: planeFailures,
  });
  const store = new TicketStore({ dataDir: path.join(root, "data") });
  const connection = store.createConnection({
    name: "Plane",
    baseUrl: plane.baseUrl,
    workspaceSlug: "acme",
    token: "plane-token",
  });
  const launched = [];
  const sent = [];
  const engineStarts = [];
  const hubSignals = [];
  const stopped = [];
  let sessionCount = 0;
  const service = new TicketService({
    store,
    memory: {
      project(id) {
        if (id === "p1") return { id, cwd: projectPath };
        if (id === "p2") return { id, cwd: otherPath };
        throw Object.assign(new Error("missing"), { status: 404 });
      },
    },
    repositories: {
      listProjects: () => [],
      token: (id) => (id === "c1" ? "gh-token" : null),
      credential: (id) => ({ id, name: "Work", host: "https://github.com" }),
    },
    github: { selections: () => [{ host: "github.com", credentialId: "c1" }] },
    gitRemotes: {
      read: async (cwd) =>
        cwd === projectPath
          ? "https://github.com/acme/app.git"
          : "git@gitlab.com:x/y.git",
    },
    async launch(body, login, trusted) {
      trusted.validateAccount?.({ id: body.accountId, tool });
      // Let a parallel start reach its lock while this one is still launching.
      await new Promise((resolve) => setTimeout(resolve, 20));
      sessionCount += 1;
      const session = {
        id: `s${sessionCount}`,
        accountId: body.accountId ?? "a1",
        tool,
        createdAt: 1,
      };
      launched.push({ body, login, trusted, session });
      return session;
    },
    chatDelivery: {
      async send(id, body) {
        sent.push({ id, ...body });
        return deliver ? deliver(sent.length) : { status: "handed-off" };
      },
    },
    sessions: { stop: async (id) => stopped.push(id) },
    pipelines: {
      async start(input, options) {
        engineStarts.push({ input, options });
        return { id: "run-1" };
      },
    },
    live: () => ({
      invalidate: (name, param) =>
        hubSignals.push(param === undefined ? name : `${name}:${param}`),
    }),
    fetchImpl: github.fetchImpl,
    ...(taken ? { taken } : {}),
  });
  const linkPlane = (id = "p1") =>
    service.setSources(id, {
      plane: { connectionId: connection.id, planeProjectId },
    });
  return {
    service,
    store,
    github,
    plane,
    connection,
    launched,
    sent,
    engineStarts,
    hubSignals,
    stopped,
    projectPath,
    linkPlane,
  };
}

test("lists GitHub and Plane tickets of a project", async (t) => {
  const { service, linkPlane } = await setup(t);
  await linkPlane();
  const view = await service.projectView("p1");
  assert.equal(view.sources.github.repo, "acme/app");
  assert.equal(view.sources.github.state, "connected");
  assert.deepEqual(view.sources.github.credential, { id: "c1", name: "Work" });
  assert.equal(view.sources.github.inProgressLabel, "in progress");
  assert.equal(view.sources.plane.identifier, "AP");
  assert.equal(view.sources.plane.connectionName, "Plane");
  assert.equal(JSON.stringify(view).includes("token"), false);
  const { tickets, errors, labels } = await service.listTickets("p1", {});
  assert.deepEqual(errors, []);
  assert.deepEqual(
    tickets.map((x) => x.key),
    ["acme/app#7", "AP-3", "acme/app#8"],
  );
  assert.deepEqual(labels, ["bug"]);
  const filtered = await service.listTickets("p1", { source: "plane" });
  assert.deepEqual(
    filtered.tickets.map((x) => x.key),
    ["AP-3"],
  );
});

test("one failing source keeps the other", async (t) => {
  const { service, linkPlane } = await setup(t);
  await linkPlane("p2");
  const view = await service.projectView("p2");
  assert.equal(view.sources.github.state, "notConnected");
  const { tickets, errors } = await service.listTickets("p2", {});
  assert.deepEqual(errors, [{ source: "github", code: "notConnected" }]);
  assert.ok(tickets.length > 0);
});

test("a refusing tracker reads as its code next to the other source", async (t) => {
  const { service, linkPlane } = await setup(t, {
    githubFailures: { "GET /repos/acme/app/issues": 401 },
  });
  await linkPlane();
  const { tickets, errors } = await service.listTickets("p1", {});
  assert.deepEqual(errors, [{ source: "github", code: "unauthorized" }]);
  assert.deepEqual(
    tickets.map((x) => x.key),
    ["AP-3"],
  );
});

test("a session start launches, sends the task and marks the ticket in progress", async (t) => {
  const { service, launched, sent, github, hubSignals, projectPath } = await setup(t);
  const result = await service.start("p1", {
    source: "github",
    key: "acme/app#7",
    kind: "session",
    session: { accountId: "a1", cwd: "/elsewhere", ticket: { key: "forged" } },
  });
  assert.equal(launched[0].body.cwd, projectPath);
  assert.equal(launched[0].body.ticket, undefined);
  assert.equal(launched[0].body.name, "acme/app#7 · Fix login");
  assert.equal(launched[0].login, false);
  assert.deepEqual(launched[0].trusted.ticket, {
    source: "github",
    key: "acme/app#7",
    title: "Fix login",
    url: "https://github.com/acme/app/issues/7",
  });
  assert.match(sent[0].text, /^Work on ticket acme\/app#7/);
  assert.equal(sent[0].id, "s1");
  assert.equal(sent[0].submit, true);
  assert.equal(result.start.writeBack.state, "done");
  assert.equal(result.start.targetId, "s1");
  assert.equal(result.session.id, "s1");
  const label = github.calls.find((c) => c.path === "/repos/acme/app/issues/7/labels");
  assert.deepEqual(label.body, { labels: ["in progress"] });
  assert.equal(label.authorization, "Bearer gh-token");
  const comment = github.calls.find((c) => c.path.endsWith("/issues/7/comments"));
  assert.equal(comment.body.body, "Started in AgentPier (session).");
  assert.doesNotMatch(comment.body.body, /https?:|\/\/|localhost|127\.0\.0\.1/);
  assert.ok(hubSignals.includes("tickets.project:p1"));
});

test("the project's own in-progress label is used", async (t) => {
  const { service, github } = await setup(t);
  await service.setSources("p1", { github: { inProgressLabel: "doing" } });
  await service.start("p1", {
    source: "github",
    key: "acme/app#7",
    kind: "session",
    session: {},
  });
  const label = github.calls.find((c) => c.path === "/repos/acme/app/issues/7/labels");
  assert.deepEqual(label.body, { labels: ["doing"] });
});

test("a pipeline start passes the ticket to the engine", async (t) => {
  const { service, engineStarts, plane, linkPlane, projectPath } = await setup(t);
  await linkPlane();
  const result = await service.start("p1", {
    source: "plane",
    key: "AP-3",
    kind: "pipeline",
    pipeline: { pipelineId: "review", task: "forged", cwd: "/elsewhere" },
  });
  assert.deepEqual(engineStarts[0].options.ticket.key, "AP-3");
  assert.equal(engineStarts[0].input.cwd, projectPath);
  assert.equal(engineStarts[0].input.pipelineId, "review");
  assert.match(engineStarts[0].input.task, /^Work on ticket AP-3/);
  assert.equal(result.start.targetId, result.run.id);
  assert.equal(result.start.writeBack.state, "done");
  const patch = plane.calls.find((c) => c.method === "PATCH");
  assert.deepEqual(patch.body, { state: "s-prog" });
  const comment = plane.calls.find((c) => c.path.endsWith("/comments/"));
  assert.equal(comment.body.comment_html, "<p>Started in AgentPier (pipeline run).</p>");
  assert.doesNotMatch(
    comment.body.comment_html,
    /https?:|\/\/|href|localhost|127\.0\.0\.1/,
  );
});

test("write-back failure keeps the start", async (t) => {
  const { service, launched, store } = await setup(t, {
    githubFailures: { "POST /repos/acme/app/issues/7/labels": 403 },
  });
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  const result = await service.start("p1", {
    source: "github",
    key: "acme/app#7",
    kind: "session",
    session: {},
  });
  assert.deepEqual(result.start.writeBack, { state: "failed", code: "forbidden" });
  assert.equal(launched.length, 1);
  assert.deepEqual(store.starts("p1")[0].writeBack, {
    state: "failed",
    code: "forbidden",
  });
  assert.deepEqual(logged, ["AgentPier could not update ticket github: forbidden"]);
  assert.equal(JSON.stringify(result).includes("gh-token"), false);
});

test("a ticket starts once unless again", async (t) => {
  const { service, launched } = await setup(t);
  const start = (extra = {}) =>
    service.start("p1", {
      source: "github",
      key: "acme/app#7",
      kind: "session",
      session: {},
      ...extra,
    });
  const [a, b] = await Promise.allSettled([start(), start({ key: "ACME/App#7" })]);
  const refused = [a, b].filter((r) => r.status === "rejected");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].reason.status, 409);
  assert.equal(refused[0].reason.message, serverMessages.tickets.alreadyStarting);
  await assert.rejects(start(), {
    status: 409,
    message: serverMessages.tickets.alreadyStarted,
  });
  await assert.doesNotReject(start({ again: true }));
  assert.equal(launched.length, 2);
});

test("a shell account cannot start a ticket session", async (t) => {
  const { service, sent, store } = await setup(t, { tool: "shell" });
  await assert.rejects(
    service.start("p1", {
      source: "github",
      key: "acme/app#7",
      kind: "session",
      session: {},
    }),
    { status: 400 },
  );
  assert.equal(sent.length, 0);
  assert.equal(store.starts("p1").length, 0);
});

test("a key of another repository or Plane project is refused before any launch", async (t) => {
  const { service, launched, engineStarts, linkPlane } = await setup(t);
  await linkPlane();
  await assert.rejects(
    service.start("p1", {
      source: "github",
      key: "other/repo#7",
      kind: "session",
      session: {},
    }),
    { status: 502, code: "notFound" },
  );
  await assert.rejects(
    service.start("p1", {
      source: "plane",
      key: "XY-3",
      kind: "pipeline",
      pipeline: { pipelineId: "x" },
    }),
    { code: "notFound" },
  );
  for (const bad of [
    { source: "gitlab", key: "a/b#1", kind: "session" },
    { source: "github", key: "a/b#1", kind: "issue" },
    { source: "plane", key: "ap-3", kind: "session" },
    { source: "github", key: "a/b#1", kind: "session", again: "yes" },
    { source: "github", key: "a/b#1", kind: "pipeline", pipeline: {} },
  ])
    await assert.rejects(service.start("p1", bad), { status: 400 });
  assert.equal(launched.length, 0);
  assert.equal(engineStarts.length, 0);
});

test("Plane project identifier and name come from Plane, not the request", async (t) => {
  const { service, connection, store } = await setup(t);
  const view = await service.setSources("p1", {
    plane: {
      connectionId: connection.id,
      planeProjectId,
      identifier: "EVIL",
      name: "Forged",
    },
  });
  assert.equal(view.sources.plane.identifier, "AP");
  assert.equal(view.sources.plane.name, "AgentPier");
  assert.equal(store.projectLink("p1").plane.identifier, "AP");
  await assert.rejects(
    service.setSources("p1", {
      plane: {
        connectionId: connection.id,
        planeProjectId: "33333333-3333-4333-8333-333333333333",
      },
    }),
    { status: 400 },
  );
  const cleared = await service.setSources("p1", { plane: null });
  assert.equal(cleared.sources.plane.state, "notConnected");
});

test("an unchanged Plane link saves without asking Plane", async (t) => {
  const planeFailures = {};
  const { service, connection, store, linkPlane } = await setup(t, { planeFailures });
  await linkPlane();
  planeFailures["GET /api/v1/workspaces/acme/projects/"] = 503;
  const view = await service.setSources("p1", {
    plane: { connectionId: connection.id, planeProjectId, inProgressStateId: null },
    github: { inProgressLabel: "doing" },
  });
  assert.equal(view.sources.plane.identifier, "AP");
  assert.equal(store.projectLink("p1").github.inProgressLabel, "doing");
  await assert.rejects(
    service.setSources("p1", {
      plane: { connectionId: connection.id, planeProjectId: otherPlaneProjectId },
    }),
    { status: 502 },
  );
});

test("an unknown project answers 404", async (t) => {
  const { service } = await setup(t);
  await assert.rejects(service.projectView("nope"), { status: 404 });
  await assert.rejects(service.listTickets("nope", {}), { status: 404 });
});

test("Plane projects and states are read with the saved token", async (t) => {
  const { service, connection, plane, hubSignals } = await setup(t);
  assert.deepEqual(
    (await service.planeProjects(connection.id)).map((p) => p.identifier),
    ["AP", "XY"],
  );
  assert.deepEqual(await service.planeStates(connection.id, planeProjectId), [
    { id: "s-todo", name: "Todo", group: "unstarted" },
    { id: "s-prog", name: "In progress", group: "started" },
    { id: "s-done", name: "Done", group: "completed" },
  ]);
  assert.ok(plane.calls.every((c) => c.apiKey === "plane-token"));
  service.updateConnection(connection.id, { name: "Renamed" });
  assert.ok(hubSignals.includes("tickets.connections"));
  assert.ok(hubSignals.includes("tickets.project"));
});

for (const [name, deliver] of [
  [
    "a thrown delivery",
    (n) => {
      if (n === 1) throw Object.assign(new Error("delivery failed"), { status: 409 });
      return { status: "handed-off" };
    },
  ],
  ["a rejected receipt", (n) => ({ status: n === 1 ? "rejected" : "pending" })],
])
  test(`${name} stops the session and leaves no start`, async (t) => {
    const { service, store, stopped, github, launched } = await setup(t, { deliver });
    const start = () =>
      service.start("p1", {
        source: "github",
        key: "acme/app#7",
        kind: "session",
        session: {},
      });
    await assert.rejects(start());
    assert.deepEqual(stopped, ["s1"]);
    assert.equal(store.starts("p1").length, 0);
    assert.equal(
      github.calls.some((c) => c.method === "POST"),
      false,
    );
    const retried = await start();
    assert.equal(retried.start.targetId, "s2");
    assert.equal(retried.start.writeBack.state, "done");
    assert.deepEqual(stopped, ["s1"]);
    assert.equal(launched.length, 2);
  });

test("manual start of a rule-queued ticket is refused, also with again", async (t) => {
  const asked = [];
  const { service, launched } = await setup(t, {
    taken: (...args) => (asked.push(args), "queued"),
  });
  for (const again of [false, true])
    await assert.rejects(
      service.start("p1", {
        source: "github",
        key: "ACME/App#7",
        kind: "session",
        session: {},
        again,
      }),
      { status: 409, message: serverMessages.tickets.ticketQueued },
    );
  assert.equal(launched.length, 0);
  // The canonical key, as the queue and the pickups spell it.
  assert.deepEqual(asked[0], ["p1", "github", "acme/app#7"]);
});

test("manual start of a picked ticket needs again", async (t) => {
  const { service, launched } = await setup(t, { taken: () => "picked" });
  const start = (again) =>
    service.start("p1", {
      source: "github",
      key: "acme/app#7",
      kind: "session",
      session: {},
      again,
    });
  await assert.rejects(start(false), {
    status: 409,
    message: serverMessages.tickets.alreadyStarted,
  });
  assert.equal(launched.length, 0);
  await assert.doesNotReject(start(true));
  assert.equal(launched.length, 1);
});

test("a manual start in flight is visible to rules and sequences", async (t) => {
  let during = null;
  const { service } = await setup(t, {
    deliver: () => {
      during = service.isStarting("p1", "github", "acme/app#7");
      return { status: "handed-off" };
    },
  });
  assert.equal(service.isStarting("p1", "github", "acme/app#7"), false);
  await service.start("p1", {
    source: "github",
    key: "acme/app#7",
    kind: "session",
    session: {},
  });
  assert.equal(during, true);
  assert.equal(service.isStarting("p1", "github", "acme/app#7"), false);
});
