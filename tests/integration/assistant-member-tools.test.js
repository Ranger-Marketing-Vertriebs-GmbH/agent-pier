import test from "node:test";
import assert from "node:assert/strict";
import { peers } from "../helpers/peer-request-fixture.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { memberActions } from "../../server/features/assistants/team-bridge-actions.js";
import { stepPolicy } from "../../server/features/assistants/memory-step-tools.js";
import { memberTeamTools } from "../../server/features/assistants/native-capabilities.js";

// The fixture's lead and members with a live team bridge.
async function bridged(t) {
  const f = await peers(t);
  const bridge = new TeamBridge({ assistants: f.assistants, teams: f.service });
  await bridge.start();
  t.after(() => bridge.close());
  const agentOf = (member) => f.store.getAssistant(f.fresh(member).assistantId);
  const chatOf = (member) => f.store.getConversation(f.fresh(member).conversationId);
  const prepare = (agent, sessionKey, action) =>
    bridge.prepare({
      agentId: agent.runtimeAgentId,
      sessionKey,
      toolCallId: crypto.randomUUID(),
      action,
    });
  // Prepares and invokes one call of a member's chat session.
  const call = async (
    member,
    action,
    input,
    sessionKey = chatOf(member).runtimeSessionKey,
  ) => {
    const { ticket } = prepare(agentOf(member), sessionKey, action);
    return bridge.invoke({ ticket, action, input });
  };
  return { ...f, bridge, agentOf, chatOf, prepare, call };
}

test("members reach the peer tools and report; leads never do", async (t) => {
  const f = await bridged(t);
  assert.deepEqual([...memberActions], ["peers", "peer_ask", "peer_delegate", "report"]);
  for (const member of [f.permanent, f.temporary]) {
    f.memberTurn(member);
    for (const action of memberActions)
      assert.equal(
        typeof f.prepare(f.agentOf(member), f.chatOf(member).runtimeSessionKey, action)
          .ticket,
        "string",
        `${member.lifetime} ${action}`,
      );
    f.settle();
  }
  // The bridge serves them from the member's own records.
  f.memberTurn(f.permanent);
  const listed = await f.call(f.permanent, "peers", {});
  assert.ok(listed.members.some((m) => m.memberId === f.second.id));
  const report = await f.call(f.permanent, "report", { kind: "result", text: "Done" });
  assert.equal(report.status, "queued");
  assert.equal(f.service.requests.store.get(report.reportId).type, "report");
  f.settle();
  // The lead's own turn never reaches them, nor do the lead tools reach a member.
  f.turn();
  const lead = f.store.getAssistant(f.parent.id);
  for (const action of memberActions)
    assert.throws(
      () => f.prepare(lead, f.chat.runtimeSessionKey, action),
      { status: 403 },
      action,
    );
  assert.equal(typeof f.prepare(lead, f.chat.runtimeSessionKey, "ask").ticket, "string");
  f.settle();
  // An archived member is refused too.
  f.memberTurn(f.second);
  f.archive(f.fresh(f.second).assistantId);
  for (const action of memberActions)
    assert.throws(
      () => f.prepare(f.agentOf(f.second), f.chatOf(f.second).runtimeSessionKey, action),
      { status: 403 },
      action,
    );
});

test("a member's routine run session reaches peer tools and report", async (t) => {
  const f = await bridged(t);
  const member = f.agentOf(f.permanent),
    lead = f.store.getAssistant(f.parent.id);
  for (const agent of [member, lead])
    f.store.updateAssistant(
      agent.id,
      { capabilities: { ...agent.capabilities, memory: true, reminders: true } },
      f.store.getAssistant(agent.id).revision,
    );
  const session = (agent) => `agent:${agent.runtimeAgentId}:cron:job-1:run:r1`;
  const runs = new Map([
    [member.id, { chat: f.chatOf(f.permanent), name: "" }],
    [lead.id, { chat: f.chat, name: "Lead check" }],
  ]);
  f.assistants.routines = {
    results: { forConversation: () => [] },
    runOrigin: (a, key) => {
      const run = runs.get(a.id);
      return run && key === session(a)
        ? {
            binding: {
              id: `binding-${a.id}`,
              assistantId: a.id,
              definition: { name: run.name },
            },
            conversation: run.chat,
          }
        : null;
    },
  };
  for (const action of memberActions)
    assert.equal(
      typeof f.prepare(member, session(member), action).ticket,
      "string",
      action,
    );
  const listed = await f.call(f.permanent, "peers", {}, session(member));
  assert.ok(listed.members.some((m) => m.memberId === f.second.id));
  const result = await f.call(
    f.permanent,
    "report",
    { kind: "problem", text: "The mailbox is full" },
    session(member),
  );
  const r = f.service.requests.store.get(result.reportId);
  assert.equal(r.origin.routine, "");
  // A lead's routine run passes the bridge but is no member: the call is refused.
  const { ticket } = f.prepare(lead, session(lead), "peer_ask");
  await assert.rejects(
    f.bridge.invoke({
      ticket,
      action: "peer_ask",
      input: { memberId: f.second.id, question: "Anything new?" },
    }),
    { status: 403 },
  );
});

test("no member tool in a memory step", async (t) => {
  const f = await bridged(t);
  f.memberTurn(f.permanent, { kind: "memory-step" });
  const agent = f.agentOf(f.permanent),
    sessionKey = f.chatOf(f.permanent).runtimeSessionKey;
  for (const action of memberActions)
    assert.throws(() => f.prepare(agent, sessionKey, action), { status: 403 }, action);
  // The plugin's step hook refuses each of them before the call reaches the bridge.
  for (const toolName of memberTeamTools)
    assert.deepEqual(
      stepPolicy(f.bridge, { agentId: agent.runtimeAgentId, sessionKey, toolName }),
      { allow: false },
      toolName,
    );
});
