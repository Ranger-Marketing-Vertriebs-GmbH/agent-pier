import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { execFixture } from "../helpers/assistant-exec-fixture.js";
import { assistantWorkflowRoutes } from "../../server/http/routes/assistant-workflows.js";

// A permanent member's shell request always waits in the member's own chat. When
// its lead delegated the turn, the lead's chat lists the same action as well, so
// the owner can decide from either place; one decision ends it in both.
async function setup(t) {
  const f = await execFixture(t);
  const lead = f.store.createAssistant({
    name: "Chief of Staff",
    model: { connectionId: "test", modelId: "fixture" },
  });
  f.assistants.teams.store.get = (id) => {
    if (id !== "team-1") throw Object.assign(Error(), { status: 404 });
    return { id, parentAssistantId: lead.id };
  };
  const app = express();
  app.use(express.json());
  app.use("/api", assistantWorkflowRoutes({ assistants: f.assistants }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({}));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const listed = async (id) => {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/assistants/${id}/actions`,
    );
    assert.equal(response.status, 200);
    return (await response.json()).actions.filter((a) => a.payload.action === "exec");
  };
  return { ...f, lead, listed };
}

test("a direct chat with the member asks only in the member's chat", async (t) => {
  const f = await setup(t);
  const action = await f.request("direct");
  assert.equal(action.leadAssistantId, undefined);
  assert.deepEqual(
    (await f.listed(f.id)).map((a) => a.id),
    [action.id],
  );
  assert.deepEqual(await f.listed(f.lead.id), []);
  assert.deepEqual(f.workflows.store.awaitingCounts(), {
    [f.id]: { own: 1, team: 0 },
  });
});

test("a lead's request asks in the member's and the lead's chat, decided once", async (t) => {
  const f = await setup(t);
  const action = await f.request(
    "asked",
    {},
    {
      kind: "lead-request",
      requestId: "r",
      leadAssistantId: f.lead.id,
      leadName: "Chief of Staff",
      display: "Check the router",
    },
  );
  assert.equal(action.state, "awaiting_approval");
  assert.equal(action.assistantId, f.id);
  assert.equal(action.leadAssistantId, f.lead.id);
  assert.equal(action.teamId, undefined, "not a team coding request of the lead");
  const [inLead] = await f.listed(f.lead.id);
  assert.equal(inLead.id, action.id);
  assert.equal(inLead.revision, action.revision);
  assert.deepEqual(f.workflows.store.awaitingCounts(), {
    [f.id]: { own: 1, team: 0 },
    [f.lead.id]: { own: 0, team: 1 },
  });
  // The lead agent's own tool listing stays its own.
  assert.deepEqual(
    f.workflows.list(f.lead.id).actions.map((a) => a.id),
    [],
  );

  const decided = await f.workflows.decide(
    inLead.id,
    { revision: inLead.revision, decision: "allow-once" },
    { kind: "owner", channel: "ui" },
  );
  assert.equal(decided.state, "completed");
  assert.deepEqual(f.resolves(), [{ id: "asked", decision: "allow-once" }]);
  assert.deepEqual(await f.listed(f.lead.id), []);
  assert.equal((await f.listed(f.id))[0].state, "completed");
  await assert.rejects(
    f.workflows.decide(
      action.id,
      { revision: action.revision, decision: "deny" },
      { kind: "owner", channel: "ui" },
    ),
    { status: 409 },
  );
  assert.deepEqual(f.workflows.store.awaitingCounts(), {});
});

test("a team assignment asks in the team lead's chat as well", async (t) => {
  const f = await setup(t);
  const action = await f.request(
    "assigned",
    {},
    { kind: "team-member", teamId: "team-1", memberId: "m1" },
  );
  assert.equal(action.leadAssistantId, f.lead.id);
  assert.deepEqual(
    (await f.listed(f.lead.id)).map((a) => a.id),
    [action.id],
  );
  // A team AgentPier no longer knows links nothing.
  const lost = await f.request(
    "lost",
    {},
    { kind: "team-member", teamId: "gone", memberId: "m1" },
  );
  assert.equal(lost.state, "awaiting_approval");
  assert.equal(lost.leadAssistantId, undefined);
});
