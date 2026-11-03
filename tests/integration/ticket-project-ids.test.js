// Ticket data of project ids that are not known now (a project moved to a new id, or
// a registry that cannot be read yet): never deleted, and never keeping a Plane
// connection in use. Fake trackers and temp dirs only.
import test from "node:test";
import assert from "node:assert/strict";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { TicketSequenceStore } from "../../server/features/tickets/sequence-store.js";
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

/** p9 is not known (the fixture's memory knows only p1) and holds ticket data. */
async function unknownProjectFixture(t) {
  const f = await ruleMonitorFixture(t);
  const connection = f.ticketStore.listConnections()[0];
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
  const rule = f.rules.create("p9", ruleInput());
  f.rules.addPickups("p9", [
    { source: "github", key: "acme/app#2", ruleId: rule.id, itemId: "i", at: 1 },
  ]);
  f.store.append("p9", f.projectPath, [queued("acme/app#3")]);
  return { f, connection, plane, rule };
}

function assertKept(f, connectionId) {
  const { dataDir } = f;
  const tickets = new TicketStore({ dataDir });
  assert.equal(tickets.projectLink("p9").plane.connectionId, connectionId);
  assert.equal(tickets.starts("p9").length, 1);
  const rules = new TicketRuleStore({ dataDir });
  assert.equal(rules.rules("p9").length, 1);
  assert.ok(rules.picked("p9", "github", "acme/app#2"));
  assert.equal(new TicketSequenceStore({ dataDir }).queue("p9").items.length, 1);
}

test("start-up and rule passes keep the data of an unknown project", async (t) => {
  const { f, connection, rule } = await unknownProjectFixture(t);
  // A fresh server reads the files, and its first rule pass runs.
  await f.monitor().run();
  assert.equal(f.rules.rule("p9", rule.id).status.error.code, "projectGone");
  assertKept(f, connection.id);
});

test("an unknown project's link does not keep a Plane connection in use", async (t) => {
  const { f, connection } = await unknownProjectFixture(t);
  f.tickets.removeConnection(connection.id);
  assert.deepEqual(f.ticketStore.listConnections(), []);
  // The link stays as it is; nothing is deleted.
  assertKept(f, connection.id);
});

test("a known project's link still keeps the connection in use", async (t) => {
  const { f, connection } = await unknownProjectFixture(t);
  await f.linkPlane();
  assert.throws(() => f.tickets.removeConnection(connection.id), { status: 409 });
  // A registry that cannot be read keeps every link in use.
  const g = await unknownProjectFixture(t);
  g.f.tickets.memory = {
    project() {
      throw Object.assign(new Error("database busy"), { status: 503 });
    },
  };
  assert.throws(() => g.f.tickets.removeConnection(g.connection.id), { status: 409 });
  assert.equal(g.f.ticketStore.listConnections().length, 1);
});
