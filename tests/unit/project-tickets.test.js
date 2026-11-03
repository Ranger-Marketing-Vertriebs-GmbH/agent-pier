import test from "node:test";
import assert from "node:assert/strict";
import {
  pipelineRunRoute,
  projectsRoute,
  projectsRoutePath,
  readProjectsRoute,
} from "../../web/features/projects/routes.js";
import {
  sourceStates,
  startOf,
  startRefusal,
  startRoute,
  ticketStartPath,
  visibleTickets,
} from "../../web/features/projects/ticket-list.js";

test("the tickets tab keeps its label filter in the address", () => {
  const route = readProjectsRoute("/projects/p1", "?tab=tickets&label=bug");
  assert.equal(route.projectTab, "tickets");
  assert.equal(route.ticketLabel, "bug");
  assert.equal(projectsRoutePath(route), "/projects/p1?tab=tickets&label=bug");
  assert.equal(readProjectsRoute("/projects/p1", "?tab=runs&label=bug").ticketLabel, "");
  assert.equal(projectsRoute().ticketLabel, "");
  assert.equal(
    projectsRoutePath(
      projectsRoute({ projectId: "p1", projectTab: "runs", ticketLabel: "bug" }),
    ),
    "/projects/p1?tab=runs",
  );
  assert.equal(
    projectsRoutePath(
      readProjectsRoute("/projects/p1", "?tab=tickets&label=in%20progress"),
    ),
    "/projects/p1?tab=tickets&label=in+progress",
  );
});

test("a label filter that is too long or holds control characters is dropped", () => {
  const long = "x".repeat(101);
  assert.equal(
    readProjectsRoute("/projects/p1", `?tab=tickets&label=${long}`).ticketLabel,
    "",
  );
  assert.equal(
    readProjectsRoute("/projects/p1", `?tab=tickets&label=${"x".repeat(100)}`)
      .ticketLabel,
    "x".repeat(100),
  );
  assert.equal(
    readProjectsRoute("/projects/p1", "?tab=tickets&label=a%0Ab").ticketLabel,
    "",
  );
});

const tickets = [
  { source: "github", key: "acme/app#7", labels: ["bug", "ui"] },
  { source: "plane", key: "AP-3", labels: ["feature"] },
  { source: "plane", key: "AP-4", labels: ["bug"] },
  { source: "github", key: "acme/app#8" },
];

test("visibleTickets filters by label and source", () => {
  assert.deepEqual(visibleTickets(tickets), tickets);
  assert.deepEqual(
    visibleTickets(tickets, { label: "bug" }).map((ticket) => ticket.key),
    ["acme/app#7", "AP-4"],
  );
  assert.deepEqual(
    visibleTickets(tickets, { source: "plane" }).map((ticket) => ticket.key),
    ["AP-3", "AP-4"],
  );
  assert.deepEqual(
    visibleTickets(tickets, { label: "bug", source: "github" }).map((t) => t.key),
    ["acme/app#7"],
  );
  assert.deepEqual(visibleTickets(null, { label: "bug" }), []);
});

test("startOf finds the newest start of a ticket", () => {
  const starts = [
    { id: "a", source: "github", key: "acme/app#7", startedAt: 100 },
    { id: "b", source: "github", key: "acme/app#7", startedAt: 300 },
    { id: "c", source: "plane", key: "acme/app#7", startedAt: 500 },
    { id: "d", source: "github", key: "acme/app#8", startedAt: 900 },
  ];
  assert.equal(startOf(starts, tickets[0]).id, "b");
  assert.equal(startOf(starts, tickets[1]), null);
  assert.equal(startOf(undefined, tickets[0]), null);
});

test("startRoute opens the session or the run", () => {
  assert.deepEqual(
    startRoute({ kind: "pipeline", targetId: "r1" }),
    pipelineRunRoute("r1"),
  );
  assert.deepEqual(startRoute({ kind: "session", targetId: "s1" }), {
    view: "workspace",
    sessionId: "s1",
  });
});

test("sourceStates reads which sources are connected", () => {
  assert.deepEqual(sourceStates(null), { github: false, plane: false });
  assert.deepEqual(
    sourceStates({
      sources: { github: { state: "connected" }, plane: { state: "notConnected" } },
    }),
    { github: true, plane: false },
  );
});

test("startRefusal tells a started ticket from one being started", () => {
  assert.equal(
    startRefusal({ status: 409, messageKey: "tickets.alreadyStarted" }),
    "started",
  );
  assert.equal(
    startRefusal({ status: 409, messageKey: "tickets.alreadyStarting" }),
    "starting",
  );
  assert.equal(startRefusal({ status: 400, messageKey: "tickets.alreadyStarted" }), null);
  assert.equal(startRefusal(new Error("x")), null);
  assert.equal(ticketStartPath("p 1"), "/tickets/projects/p%201/start");
});
