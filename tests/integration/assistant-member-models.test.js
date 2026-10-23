import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { memberGrantFixture } from "../helpers/member-grant-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";

async function setup(t) {
  const f = await memberGrantFixture(t);
  f.assistants.models = {
    catalog: { list: () => [] },
    listCapabilities: () => [
      {
        id: "local",
        name: "Local",
        providerId: "endpoint",
        available: true,
        models: [{ modelId: "qwen", label: "Qwen", contextTokens: 32000 }],
      },
    ],
    imageInput: () => false,
  };
  const teams = new TeamService({
    assistants: f.assistants,
    store: f.teams,
    autoStart: false,
  });
  t.after(() => teams.close());
  return { ...f, service: teams };
}

test("a lead lists the models with its own and its members' current ones", async (t) => {
  const f = await setup(t);
  const result = f.service.models(await f.invocation(randomUUID()), { query: "qw" });
  assert.equal(result.total, 1);
  assert.equal(result.models[0].modelId, "qwen");
  assert.deepEqual(result.current.lead, f.store.getAssistant(f.id).model);
  assert.deepEqual(
    result.current.members.map(({ memberId, name }) => ({ memberId, name })),
    [{ memberId: f.member.id, name: "Scout" }],
  );
  assert.deepEqual(result.current.members[0].model, f.agent().model);
  // The input is checked exactly.
  for (const input of [{ other: true }, { limit: 0 }])
    assert.throws(() => f.service.models({ attemptId: "x", assertCurrent() {} }, input), {
      status: 400,
    });
});

test("only a lead reaches the models tool; a member is refused", async (t) => {
  const f = await setup(t);
  const bridge = new TeamBridge({
    assistants: {
      store: f.store,
      ledger: f.assistants.ledger,
      runtime: { client: { ready: true }, status: () => ({}) },
    },
    teams: {},
  });
  bridge.closed = false;
  // The lead's own turn gets a ticket for it (its team turn is over by then).
  f.assistants.ledger.transition(f.proposed.parentAttemptId, "completed");
  await f.invocation(randomUUID());
  const lead = f.store.getAssistant(f.id);
  assert.ok(
    bridge.prepare({
      action: "models",
      agentId: lead.runtimeAgentId,
      sessionKey: f.store.getConversation(f.channel.conversationId).runtimeSessionKey,
      toolCallId: "lead-call",
    }).ticket,
  );
  const turn = f.assistants.ledger.accept(f.memberChat.id, {
    clientRequestId: "member",
    text: "Go",
  });
  const attempt = f.assistants.ledger.recordAttempt(turn.id);
  assert.throws(
    () =>
      bridge.valid({
        action: "models",
        attemptId: attempt.id,
        sessionKey: "member-session",
        agentId: f.agent().runtimeAgentId,
        generation: 1,
      }),
    { status: 403 },
  );
});
