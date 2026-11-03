// The ticket data of removed projects: dropped at start-up and before a Plane
// connection is removed, so it never keeps the connection in use. Fake trackers and
// temp dirs only.
import test from "node:test";
import assert from "node:assert/strict";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { TicketSequenceStore } from "../../server/features/tickets/sequence-store.js";
import { ticketProjectData } from "../../server/features/tickets/gone-projects.js";
import {
  PLANE_PROJECT,
  SESSION,
  ruleInput,
  ruleMonitorFixture,
} from "../helpers/rule-monitor-fixture.js";

const queued = (key) => ({
  source: "github",
  key,
  title: "T",
  url: "",
  kind: "session",
  options: { allowMerge: false, session: SESSION },
});

async function setup(t) {
  const f = await ruleMonitorFixture(t);
  const exclusive = [];
  const engine = {
    exclusive: async (projectId, action) => (exclusive.push(projectId), action()),
  };
  f.tickets.projectData = ticketProjectData({ rules: f.rules, store: f.store, engine });
  const connection = f.ticketStore.listConnections()[0];
  // p9 is gone (the fixture's memory knows only p1) and still holds everything.
  const plane = {
    connectionId: connection.id,
    planeProjectId: PLANE_PROJECT,
    identifier: "AP",
    name: "AgentPier",
  };
  f.ticketStore.setProjectLink("p9", f.projectPath, { plane });
  f.ticketStore.addStart({
    projectId: "p9",
    source: "github",
    key: "acme/app#1",
    title: "T",
    url: "",
    kind: "session",
    targetId: "s1",
    writeBack: { state: "done" },
  });
  f.rules.create("p9", ruleInput());
  f.rules.addPickups("p9", [
    { source: "github", key: "acme/app#2", ruleId: "r", itemId: "i", at: 1 },
  ]);
  f.store.append("p9", f.projectPath, [queued("acme/app#3")]);
  // p1 exists and keeps its own.
  f.rules.create("p1", ruleInput());
  f.store.append("p1", f.projectPath, [queued("acme/app#4")]);
  return { f, connection, exclusive };
}

test("removing a Plane connection first drops the data of removed projects", async (t) => {
  const { f, connection, exclusive } = await setup(t);
  await f.tickets.removeConnection(connection.id);
  assert.deepEqual(f.ticketStore.listConnections(), []);
  assert.equal(f.ticketStore.projectLink("p9").plane, null);
  assert.deepEqual(f.ticketStore.starts("p9"), []);
  assert.deepEqual(f.rules.rules("p9"), []);
  assert.equal(f.rules.picked("p9", "github", "acme/app#2"), null);
  assert.equal(f.store.queue("p9"), null);
  assert.deepEqual(exclusive, ["p9"]);
  assert.equal(f.rules.rules("p1").length, 1);
  assert.equal(f.store.queue("p1").items.length, 1);
  // Saved: a restart reads the same.
  const dataDir = f.dataDir;
  assert.equal(new TicketStore({ dataDir }).projectLink("p9").plane, null);
  assert.deepEqual(new TicketRuleStore({ dataDir }).projectIds(), new Set(["p1"]));
  assert.equal(new TicketSequenceStore({ dataDir }).queue("p9"), null);
});

test("a project that cannot be read right now keeps its data and the connection", async (t) => {
  const { f, connection } = await setup(t);
  f.tickets.memory = {
    project() {
      throw Object.assign(new Error("database busy"), { status: 503 });
    },
  };
  await assert.rejects(f.tickets.removeConnection(connection.id), { status: 409 });
  assert.equal(f.ticketStore.projectLink("p9").plane.connectionId, connection.id);
  assert.equal(f.rules.rules("p9").length, 1);
  assert.equal(f.store.queue("p9").items.length, 1);
});

test("the start-up sweep reports the projects it dropped", async (t) => {
  const { f } = await setup(t);
  assert.deepEqual(await f.tickets.forgetGoneProjects(), ["p9"]);
  assert.deepEqual(await f.tickets.forgetGoneProjects(), []);
});
