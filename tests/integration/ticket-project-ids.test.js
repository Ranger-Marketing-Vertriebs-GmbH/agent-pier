// Ticket data of project ids that are not known now (a project moved to a new id, or
// a registry that cannot be read yet): never deleted, and never keeping a Plane
// connection in use. Fake trackers and temp dirs only.
import test from "node:test";
import assert from "node:assert/strict";
import { TicketStore } from "../../server/features/tickets/ticket-store.js";
import { TicketRuleStore } from "../../server/features/tickets/rule-store.js";
import { TicketSequenceStore } from "../../server/features/tickets/sequence-store.js";
import { ticketProjectMoves } from "../../server/features/tickets/project-moves.js";
import { ProjectRebind } from "../../server/application/project-rebind.js";
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

/** A ProjectRebind whose other moves are no-ops, with the real ticket move bound. */
function rebindFor(f) {
  const exclusive = [];
  const engine = {
    exclusive: async (projectId, action) => (exclusive.push(projectId), action()),
  };
  const rebind = new ProjectRebind({
    dataDir: f.dataDir,
    memory: {
      reboundTo: () => null,
      pendingMerge: () => null,
      merge() {},
      finishMerge() {},
      hasProject: () => false,
      ownsEntries: () => false,
    },
    sshManagement: { adoptProject: async () => {}, knowsProject: () => false },
    artifacts: { moveProject: async () => {}, ownsProject: () => false },
    sessions: {},
    audit: { append() {} },
  });
  rebind.tickets = ticketProjectMoves({
    ticketStore: f.ticketStore,
    rules: f.rules,
    store: f.store,
    engine,
    live: () => null,
  });
  return { rebind, exclusive };
}

test("a merge moves the ticket links, queue and rules to the new project id", async (t) => {
  const { f, connection, rule } = await unknownProjectFixture(t);
  // p1 already queues #3 and has its own rule for the same label.
  f.store.append("p1", f.projectPath, [queued("acme/app#3"), queued("acme/app#4")]);
  f.rules.create("p1", ruleInput());
  f.rules.create("p9", ruleInput({ label: "ready" }));
  const { rebind, exclusive } = rebindFor(f);
  assert.equal(rebind.remnants("p9"), true);
  await rebind.mergeDuplicate("p9", { id: "p1" });
  assert.deepEqual(exclusive, ["p9", "p1"]);
  // Link and starts move; nothing is left under the old id.
  assert.equal(f.ticketStore.projectLink("p1").plane.connectionId, connection.id);
  assert.equal(f.ticketStore.projectLink("p9").plane, null);
  assert.equal(f.ticketStore.starts("p1").length, 1);
  // p1's own rule for "agent" wins; "ready" moves; the pickups move.
  assert.deepEqual(
    f.rules.rules("p1").map((r) => r.label),
    ["agent", "ready"],
  );
  assert.equal(f.rules.rule("p1", rule.id), null);
  assert.equal(f.rules.picked("p1", "github", "acme/app#2").ruleId, rule.id);
  assert.deepEqual(f.rules.rules("p9"), []);
  // The queue moves behind p1's items, #3 only once.
  assert.deepEqual(
    f.store.queue("p1").items.map((item) => item.key),
    ["acme/app#3", "acme/app#4"],
  );
  assert.equal(f.store.queue("p9"), null);
  assert.equal(rebind.remnants("p9"), false);
  // A repeated move changes nothing.
  await rebind.mergeDuplicate("p9", { id: "p1" });
  assert.equal(f.store.queue("p1").items.length, 2);
});

test("a rebind to a project without ticket data moves everything as it is", async (t) => {
  const { f, connection } = await unknownProjectFixture(t);
  const { rebind } = rebindFor(f);
  await rebind.tickets.moveProject("p9", "p1");
  assert.equal(f.ticketStore.projectLink("p1").plane.connectionId, connection.id);
  assert.deepEqual(
    f.store.queue("p1").items.map((item) => item.key),
    ["acme/app#3"],
  );
  assert.equal(f.rules.rules("p1").length, 1);
  assert.ok(f.rules.picked("p1", "github", "acme/app#2"));
});
